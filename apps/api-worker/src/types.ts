export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  APP_ENV?: string;
  JWT_SECRET?: string;
  // Optional previous signing key. When set, tokens signed with this key
  // continue to verify (read-only) so the active JWT_SECRET can be rotated
  // without forcing every signed-in user to re-authenticate. Both keys are
  // tried in turn during verify; only JWT_SECRET is used for signing new tokens.
  JWT_SECRET_PREVIOUS?: string;
  // Stable identifier embedded in the JWT header as `kid`. Comma-separated
  // values map index-0 → JWT_SECRET, index-1 → JWT_SECRET_PREVIOUS (and so on).
  // If unset we fall back to deriving deterministic kids from the secrets
  // themselves so verification still works during a partial config rollout.
  JWT_KIDS?: string;
  JWT_ISSUER?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  // CORS allowlist. Either a single origin ("https://app.example.com"),
  // a CSV ("https://app.example.com, https://staging.example.com"), or "*".
  CORS_ORIGIN?: string;
  BOOTSTRAP_ADMIN_USERNAME?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
  // Optional: Cloudflare Vectorize index for semantic search.
  // When unbound, the semantic-search endpoints respond with 503; the
  // standard FTS5 list endpoint keeps working independently.
  VECTORIZE?: VectorizeIndex;
  // Optional: Workers AI binding used to compute embeddings.
  AI?: Ai;
}

export interface AuthClaims {
  sub: string;
  username: string;
  role: 'admin' | 'librarian' | 'viewer';
  iat: number;
  exp: number;
  iss: string;
}

export interface AuthContextValue {
  user: AuthClaims;
}
