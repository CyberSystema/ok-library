# OK Library Organizer

A Cloudflare-first library organizer with:
- Web admin app (Vite + React)
- API backend (Cloudflare Workers + D1 + KV + R2)
- Mobile app (Flutter, iOS + Android)

## Implemented Features
- Book CRUD with optimistic version conflict checks
- Borrow and return workflows
- Search/filter/sort books
- Room and shelf location fields
- Custom field definition management
- Unique QR/barcode code assignment and scan resolution
- CSV export and JSON import pipeline
- Offline sync endpoints for mobile
- Audit logging for mutating actions
- Staff login with token-based auth and role checks

## Repository Layout
- apps/api-worker: Cloudflare Worker API and D1 migrations
- apps/web: Staff web UI
- apps/mobile: Flutter native app skeleton
- packages/shared: Shared validation schemas and contracts

## Quick Start (Local)
1. Install dependencies:
   - npm install
2. Configure API env vars:
   - copy apps/api-worker/.dev.vars.example to apps/api-worker/.dev.vars
   - set secure JWT_SECRET and admin credentials
3. Create D1 database and KV namespace in Cloudflare dashboard.
4. Update binding IDs in apps/api-worker/wrangler.toml.
5. Apply migrations locally:
   - npm run migrate:local
6. Run API:
   - npm run dev:api
7. Run web app:
   - cp apps/web/.env.example apps/web/.env
   - npm run dev:web

## Security Defaults
- Role-based authorization (admin, librarian, viewer)
- Signed bearer access tokens
- Audit trail on mutating operations
- Response security headers
- Input validation with zod

## Cloudflare Deployment
1. Set Worker secrets:
   - wrangler secret put JWT_SECRET
   - wrangler secret put BOOTSTRAP_ADMIN_PASSWORD
2. Set vars and binding IDs in wrangler.toml.
3. Apply remote migration:
   - npm --workspace apps/api-worker run migrate:remote
4. Deploy worker:
   - npm run deploy:api

## Mobile Build
See apps/mobile/README.md for Flutter setup and native builds.

## Additional Documentation
- API details: apps/api-worker/README.md
- Production checklist: docs/PRODUCTION_CHECKLIST.md

## Important Free-Tier Guidance
- Keep list and search queries paginated.
- Rely on local mobile cache and batched sync.
- Use short-lived KV cache entries for read-heavy endpoints.
- Monitor D1 writes/day and KV operations/day.
