import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';
import type { AuthClaims, Env } from './types';

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(input: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return bytesToBase64Url(new Uint8Array(sig));
}

// ─── Password hashing ──────────────────────────────────────────────────────
// We support two formats so an existing deploy keeps working:
//
//   • Legacy: unsalted SHA-256 hex (rows where password_salt IS NULL).
//   • New:    PBKDF2-SHA-256 with a per-user random salt + iteration count.
//
// On a successful login against the legacy hash, the login handler rehashes
// with PBKDF2 and writes the new format back to the row, so over time every
// active user's password is migrated without forcing a reset.

// Cloudflare Workers' Web Crypto caps PBKDF2 iterations at 100_000. Anything
// higher throws `NotSupportedError` at runtime, so stay at the cap.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPasswordSha256(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return bytesToHex(new Uint8Array(digest));
}

export async function hashPasswordPbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    PBKDF2_KEY_BYTES * 8
  );
  return bytesToHex(new Uint8Array(bits));
}

export function generateSaltHex(): string {
  const bytes = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function defaultPbkdf2Iterations(): number {
  return PBKDF2_ITERATIONS;
}

// Constant-time string comparison to make timing-side-channel attacks on
// password verification impractical, even though our login is rate-limited.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Backwards-compat shim used by ensureBootstrapAdmin (which seeds a user once,
// from BOOTSTRAP_ADMIN_PASSWORD). We now seed with PBKDF2 directly there too,
// but keep the legacy entry point working for any caller that still uses it.
export async function hashPassword(password: string): Promise<string> {
  return hashPasswordSha256(password);
}

// Resolves the [active, previous?] pair of signing keys with a stable `kid`
// derived either from JWT_KIDS (CSV) or, as a fallback, from a short hash of
// the secret itself. Verification is willing to try either secret so an
// in-flight rotation doesn't ground every active session.
async function resolveSigningKeys(
  env: Env
): Promise<Array<{ kid: string; secret: string; active: boolean }>> {
  const active = env.JWT_SECRET;
  if (!active) {
    throw new HTTPException(500, { message: 'JWT_SECRET is not configured' });
  }
  const previous = env.JWT_SECRET_PREVIOUS;
  const declaredKids = (env.JWT_KIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const kidFor = async (secret: string, index: number): Promise<string> => {
    if (declaredKids[index]) return declaredKids[index];
    // Stable, non-secret identifier: first 8 hex chars of SHA-256(secret).
    // The kid travels in the JWT header in clear; using a hash (not the
    // secret itself) keeps the key material from leaking via the kid claim.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return bytesToHex(new Uint8Array(digest)).slice(0, 8);
  };

  const keys = [{ kid: await kidFor(active, 0), secret: active, active: true }];
  if (previous) keys.push({ kid: await kidFor(previous, 1), secret: previous, active: false });
  return keys;
}

export async function createAccessToken(env: Env, claims: Omit<AuthClaims, 'iat' | 'exp' | 'iss'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.ACCESS_TOKEN_TTL_SECONDS ?? '43200');
  const issuer = env.JWT_ISSUER ?? 'ok-library-api';
  const keys = await resolveSigningKeys(env);
  const signingKey = keys[0];

  const header = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: signingKey.kid }))
  );
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        ...claims,
        iat: now,
        nbf: now,
        exp: now + ttl,
        iss: issuer
      })
    )
  );

  const sig = await sign(`${header}.${payload}`, signingKey.secret);
  return `${header}.${payload}.${sig}`;
}

export async function verifyAccessToken(env: Env, token: string): Promise<AuthClaims> {
  const keys = await resolveSigningKeys(env);

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }

  const [header, payload, signature] = parts;

  // Pin the algorithm. Without this an attacker could craft a token with
  // `alg: none` or `alg: HS512` — the latter would still recompute fine here
  // but reject any future migration to alg-aware libraries. We never want to
  // accept anything but HS256 against our HMAC secret.
  let headerObj: { alg?: string; kid?: string; typ?: string };
  try {
    headerObj = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header))) as {
      alg?: string;
      kid?: string;
      typ?: string;
    };
  } catch {
    throw new HTTPException(401, { message: 'Invalid token header' });
  }
  if (headerObj.alg !== 'HS256') {
    throw new HTTPException(401, { message: 'Unsupported token algorithm' });
  }

  // Prefer the kid-indexed key for direct verification; fall back to trying
  // both. Both branches use constant-time comparison.
  const candidates = headerObj.kid
    ? [...keys.filter((k) => k.kid === headerObj.kid), ...keys.filter((k) => k.kid !== headerObj.kid)]
    : keys;

  let verified = false;
  for (const candidate of candidates) {
    const expected = await sign(`${header}.${payload}`, candidate.secret);
    if (constantTimeEqual(signature, expected)) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    throw new HTTPException(401, { message: 'Invalid token signature' });
  }

  // A malformed payload (truncated, non-JSON, etc.) would otherwise throw a
  // SyntaxError and surface as 500 to the client. Translate to the correct
  // 401 so monitoring isn't polluted with auth-shaped 5xx noise.
  let claims: AuthClaims & { nbf?: number };
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as AuthClaims & {
      nbf?: number;
    };
  } catch {
    throw new HTTPException(401, { message: 'Invalid token payload' });
  }
  const now = Math.floor(Date.now() / 1000);
  // Allow a small clock-skew window (60s) so clients with slightly-off clocks
  // don't bounce against a freshly-issued token.
  const SKEW_SECONDS = 60;
  if (claims.exp < now - SKEW_SECONDS) {
    throw new HTTPException(401, { message: 'Token expired' });
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_SECONDS) {
    throw new HTTPException(401, { message: 'Token not yet valid' });
  }

  const issuer = env.JWT_ISSUER ?? 'ok-library-api';
  if (claims.iss !== issuer) {
    throw new HTTPException(401, { message: 'Invalid token issuer' });
  }

  return claims;
}

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { user: AuthClaims } }>, next: Next) {
  const auth = c.req.header('authorization');
  const bearerToken = auth && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const cookieToken = getCookieValue(c.req.header('cookie'), 'ok_library_session');
  const token = bearerToken ?? cookieToken;

  if (!token) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }

  const claims = await verifyAccessToken(c.env, token);
  c.set('user', claims);
  await next();
}

export function requireRole(roles: Array<'admin' | 'librarian' | 'viewer'>) {
  return async (
    c: Context<{ Bindings: Env; Variables: { user: AuthClaims } }>,
    next: Next
  ): Promise<void> => {
    const user = c.get('user');
    if (!roles.includes(user.role)) {
      throw new HTTPException(403, { message: 'Insufficient role' });
    }
    await next();
  };
}

// Per-request permission cache. Without this each `requirePermission(...)`
// middleware did a fresh D1 round-trip; a route with multiple permission
// checks (or a flow that lazily inspects permissions) burned one read per
// check. We stash the whole role's permission map under a symbolic key on
// the Hono context so the FIRST check loads it once and every subsequent
// one is in-memory.
type PermissionsCacheCtx = Context<{ Bindings: Env; Variables: Record<string, unknown> }>;
const PERMS_CACHE_KEY = '__okPermsForRole';

async function getRolePermissions(
  c: PermissionsCacheCtx,
  role: 'librarian' | 'viewer'
): Promise<Map<string, boolean>> {
  const cached = c.get(PERMS_CACHE_KEY) as Map<string, boolean> | undefined;
  if (cached) return cached;
  const rows = await c.env.DB.prepare(
    'SELECT permission, allowed FROM role_permissions WHERE role = ?'
  ).bind(role).all<{ permission: string; allowed: number }>();
  const map = new Map<string, boolean>();
  for (const row of rows.results ?? []) {
    map.set(row.permission, row.allowed === 1);
  }
  c.set(PERMS_CACHE_KEY, map);
  return map;
}

// Permission-based middleware. Admins always pass. For other roles, the
// `role_permissions` table is consulted; missing rows fall back to the
// caller-supplied default (typically `false`).
// Programmatic permission check with the same semantics as requirePermission
// (admin always allowed; otherwise the role_permissions table, falling back to
// the caller-supplied default). Use this to gate individual operations that
// don't have their own middleware — e.g. the per-mutation branches of
// /api/sync/push, which would otherwise inherit only the endpoint's coarse gate.
export async function userHasPermission(
  c: Context<{ Bindings: Env; Variables: { user: AuthClaims } }>,
  permission: string,
  defaultAllowed: { librarian?: boolean; viewer?: boolean } = {}
): Promise<boolean> {
  const user = c.get('user');
  if (user.role === 'admin') return true;
  const role = user.role as 'librarian' | 'viewer';
  const map = await getRolePermissions(c as unknown as PermissionsCacheCtx, role);
  return map.has(permission) ? map.get(permission) === true : Boolean(defaultAllowed[role]);
}

export function requirePermission(
  permission: string,
  defaultAllowed: { librarian?: boolean; viewer?: boolean } = {}
) {
  return async (
    c: Context<{ Bindings: Env; Variables: { user: AuthClaims } }>,
    next: Next
  ): Promise<void> => {
    if (!(await userHasPermission(c, permission, defaultAllowed))) {
      throw new HTTPException(403, { message: `Permission denied: ${permission}` });
    }
    await next();
  };
}
