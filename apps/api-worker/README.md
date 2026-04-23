# API Worker

Cloudflare Worker backend for OK Library Organizer.

## Core capabilities
- Staff authentication and role authorization
- Book CRUD with optimistic version checks
- Borrow and return transactions
- Code assignment (QR/barcode) with uniqueness checks
- Scan-to-book lookup
- Room and custom field management
- Bulk import and CSV export
- Offline sync pull/push endpoints
- Audit logging for mutating operations
- Per-IP rate limiting using KV

## Local dev
1. Configure env vars:
   - copy .dev.vars.example to .dev.vars
2. Set bindings and IDs in wrangler.toml.
3. Apply migrations:
   - wrangler d1 migrations apply ok_library --local
4. Run:
   - wrangler dev

## Required bindings
- D1: DB
- KV: CACHE
- R2: ASSETS

## Security notes
- Use a long random JWT_SECRET.
- Restrict CORS_ORIGIN to trusted web host in production.
- Rotate bootstrap admin password immediately after first login.
