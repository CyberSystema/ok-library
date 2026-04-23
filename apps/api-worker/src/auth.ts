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

export async function hashPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createAccessToken(env: Env, claims: Omit<AuthClaims, 'iat' | 'exp' | 'iss'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.ACCESS_TOKEN_TTL_SECONDS ?? '43200');
  const issuer = env.JWT_ISSUER ?? 'ok-library-api';
  const secret = env.JWT_SECRET;

  if (!secret) {
    throw new HTTPException(500, { message: 'JWT_SECRET is not configured' });
  }

  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        ...claims,
        iat: now,
        exp: now + ttl,
        iss: issuer
      })
    )
  );

  const sig = await sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${sig}`;
}

export async function verifyAccessToken(env: Env, token: string): Promise<AuthClaims> {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new HTTPException(500, { message: 'JWT_SECRET is not configured' });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }

  const [header, payload, signature] = parts;
  const expected = await sign(`${header}.${payload}`, secret);
  if (signature !== expected) {
    throw new HTTPException(401, { message: 'Invalid token signature' });
  }

  const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as AuthClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    throw new HTTPException(401, { message: 'Token expired' });
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
