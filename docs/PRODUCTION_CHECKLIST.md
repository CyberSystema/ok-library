# Production Checklist

## Cloudflare resources
1. Create D1 database and apply migrations remotely.
2. Create KV namespace for rate-limits/caching.
3. Create R2 bucket for future asset storage.
4. Update binding IDs in apps/api-worker/wrangler.toml.

## Secrets and vars
1. Set JWT_SECRET via wrangler secret.
2. Set BOOTSTRAP_ADMIN_PASSWORD via wrangler secret.
3. Set JWT_ISSUER and ACCESS_TOKEN_TTL_SECONDS vars.
4. Set CORS_ORIGIN to deployed web domain only.

## Security hardening
1. Replace bootstrap password immediately after first login.
2. Restrict admin role access to trusted staff accounts.
3. Review audit logs regularly for unusual mutation spikes.
4. Enable Cloudflare WAF managed rules.

## Data and backups
1. Verify migration consistency in staging before prod.
2. Export periodic DB snapshots.
3. Test restore procedure on non-production environment.

## Performance
1. Keep search paginated (do not request very large pages).
2. Monitor D1 write/read quotas on free tier.
3. Monitor KV operation count for rate-limiter and cache.
4. Keep mobile sync batches moderate (<=200 operations per push).

## Release gates
1. npm run typecheck must pass.
2. npm --workspace apps/web run build must pass.
3. Smoke test login, CRUD, borrow/return, code generation, scan resolve, import, export.
4. Confirm iOS and Android app builds with correct API_BASE.
