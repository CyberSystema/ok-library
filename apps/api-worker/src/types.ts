export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  APP_ENV?: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  CORS_ORIGIN?: string;
  BOOTSTRAP_ADMIN_USERNAME?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
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
