# Production Checklist

This document is the authoritative go-live and ongoing-operations checklist for
the OK Library Organizer. Every item should be **verified** (not just read)
before the system handles real patron data.

---

## 1. Cloudflare resources

1. Create the D1 database (`ok_library`) and apply all migrations remotely:
   ```bash
   npx wrangler d1 migrations apply ok_library --config apps/api-worker/wrangler.toml --remote
   ```
   Confirm migration `0008_borrow_active_loan_unique.sql` is the latest applied.
2. Create the KV namespace used for the books-cache versioning and rate limits.
3. Create the R2 bucket for cover storage.
4. Update binding IDs in `apps/api-worker/wrangler.toml` for `DB`, `CACHE`,
   `ASSETS`, then redeploy.
5. Verify `wrangler d1 execute ok_library --command 'PRAGMA foreign_keys'`
   reports `1` against the production binding.

## 2. Secrets and vars

1. `JWT_SECRET` — at least 32 bytes of CSPRNG output; rotate every 12 months.
   ```bash
   openssl rand -base64 48 | npx wrangler secret put JWT_SECRET --config apps/api-worker/wrangler.toml
   ```
2. `BOOTSTRAP_ADMIN_PASSWORD` — set once for the very first login, then **must
   be rotated immediately** (see §3.1).
3. Plain vars (in `wrangler.toml` `[vars]`):
   - `APP_ENV = "production"`
   - `JWT_ISSUER = "ok-library-api"`
   - `ACCESS_TOKEN_TTL_SECONDS = "43200"` (12h)
   - `CORS_ORIGIN` — exact deployed origin, **never `*`** in production.
     The worker now hard-fails on boot when `APP_ENV === "production"` and
     CORS_ORIGIN is missing or wildcard, so a misconfiguration cannot ship.

## 3. Security hardening

1. **Bootstrap admin rotation** (mandatory):
   - Sign in once with the bootstrap credentials.
   - In Settings → Users, create a new admin account with the real operator's
     name and a strong unique password.
   - Sign out, sign in as the new admin.
   - Disable (or delete) the bootstrap admin.
   - Remove the `BOOTSTRAP_ADMIN_PASSWORD` secret:
     `npx wrangler secret delete BOOTSTRAP_ADMIN_PASSWORD`.
2. Restrict the `admin` role to trusted staff. Use `librarian` and `viewer`
   for everyone else; the role/permission matrix is editable in
   Settings → Permissions.
3. Review audit logs weekly for: bursts of `book.delete`, off-hours mutations,
   any `auth.login.failed` clusters.
4. Enable Cloudflare WAF Managed Ruleset and the OWASP Core Rule Set on the
   API hostname. Add a custom rule to block requests with no `User-Agent`
   header to `/api/*`.
5. Confirm the `Set-Cookie` for `ok_library_session` carries
   `HttpOnly; Secure; SameSite=None; Partitioned` in production responses.
6. Run `npm audit --omit=dev` and review every advisory before deploying.

## 4. Data, backups, retention

1. Verify migrations in staging **with production-shaped data** before prod.
2. **Daily logical backup** of D1:
   ```bash
   npx wrangler d1 export ok_library --remote --output backups/$(date +%F).sql
   ```
   Store the dump in encrypted offsite storage (R2 with object-lock or a
   separate Cloudflare account) for at least 90 days.
3. **Restore drill** — quarterly. Spin up a fresh D1 named
   `ok_library_restore_test`, apply the latest dump, confirm row counts and
   a sample of book detail pages match.
4. **Retention policy** (see §10): borrow transactions retained for 24 months
   after `returned_at`; audit logs for 12 months. Run the
   `/api/maintenance/cleanup` endpoint (admin-gated) on a monthly schedule
   via Cloudflare Cron Triggers.

## 5. Performance & quotas

1. Keep `pageSize` ≤ 100. The UI enforces this; do not bypass it client-side.
2. Monitor D1 read/write quotas via the Cloudflare dashboard. Alert
   thresholds: 60% of plan reads/day → warning, 80% → page on-call.
3. Monitor KV ops/day; the books-cache keys are read-heavy.
4. Mobile sync batches are limited server-side to 200 operations per push;
   the mobile client ships a per-mutation push-then-delete loop so a
   server-side rejection no longer drops queued mutations.

## 6. Mobile-app security (Flutter)

1. The local SQLite database is encrypted with **SQLCipher**
   (`sqflite_sqlcipher`). The 32-byte hex key is generated per install with
   `Random.secure()` and stored in the OS keychain via
   `flutter_secure_storage` (iOS `first_unlock_this_device`,
   Android `encryptedSharedPreferences: true`).
2. The JWT is stored only in the same keychain — never in `SharedPreferences`
   or on disk. `restoreSession()` reads it on app boot; `logout()` clears
   token + DB + state.
3. **Key-rotation procedure** (run if a device is suspected compromised):
   - Sign out the user from the affected device — `SecureStore.deleteToken()`
     and `LocalDb.clear()` together delete the encrypted DB file. The next
     sign-in regenerates a fresh key.
   - Server-side, rotate that user's password to invalidate any cached JWT
     copies.
4. iOS App Transport Security: keep arbitrary loads disabled; the API uses
   HTTPS-only.
5. Android: `usesCleartextTraffic` must be `false`.
6. Builds must set `--dart-define=API_BASE=https://…` for release. The
   default in code is the production worker, but CI should pin it explicitly.

## 7. Monitoring, alerting, SLA

1. **Logs** — enable Cloudflare Workers Logpush to your SIEM/object store.
   Retain 30 days.
2. **Metrics dashboards** — Workers Analytics (requests, errors, p50/p95
   latency, CPU time), D1 (queries, errors), KV (ops, errors).
3. **Alerts** (PagerDuty / email-to-on-call):
   - 5xx rate > 1% for 5 minutes
   - p95 latency > 1500ms for 10 minutes
   - D1 error rate > 0.5% for 5 minutes
   - Daily backup job missing
4. **SLA target** (internal): 99.5% monthly availability.
5. **On-call runbook** entries:
   - "API returns 500 with `CORS_ORIGIN missing in production`"
     → set the secret, redeploy.
   - "Borrow returns 409 active_loan_exists" → expected; the partial unique
     index from migration `0008` doing its job.
   - "Mobile users report blank library after re-install" → expected; the
     SQLCipher key is per-install. Sign-in re-syncs from the API.

## 8. Release gates (all must be green)

1. `npx tsc -p apps/api-worker/tsconfig.json --noEmit` — clean
2. `npx tsc -p packages/shared/tsconfig.json --noEmit` — clean
3. `npx tsc -p apps/web/tsconfig.json --noEmit` — clean
4. `npm --workspace apps/web run build` — clean (no warnings)
5. `flutter analyze` in `apps/mobile/` — clean against the strict
   `analysis_options.yaml`
6. Smoke tests on staging:
   - Login / logout
   - Create / edit / delete book
   - Borrow / return (+ verify duplicate-borrow returns 409)
   - QR code generation + scan resolve
   - XLSX import (catalog + legacy formats, with `--dry-run` first)
   - CSV export
   - Mobile cold-start session restore
7. `scripts/reset_database.mjs --remote` is locked behind a typed
   `DELETE PRODUCTION` confirmation. Never run it against production
   without an out-of-band sign-off.

## 9. CORS, auth, and cookies — verification recipe

```bash
# Should be 200 with Access-Control-Allow-Origin matching CORS_ORIGIN exactly.
curl -i -X OPTIONS https://API_HOST/api/books \
  -H "Origin: https://ok-library.pages.dev" \
  -H "Access-Control-Request-Method: GET"

# Should be 401 without auth, never 500.
curl -i https://API_HOST/api/books
```

## 10. GDPR / privacy

The system stores patron names and contact strings on the `borrowers` table.
Provide the following operator workflows (admin role only):

1. **Data-export** — produce a JSON export for a named borrower including
   all of their `borrow_transactions`.
2. **Data-deletion / right-to-erasure** — anonymize the row (clear `name`
   and `contact`, retain the id) rather than hard-delete, so historical
   loan stats remain accurate without identifying the person.
3. **Retention** — see §4.4. Document the period in your privacy notice and
   keep it consistent with what cleanup actually does.
4. **Lawful basis** — for an internal library, "legitimate interest" usually
   applies. Document before go-live.
5. **Data-processing addendum** — Cloudflare's standard DPA covers Workers,
   D1, KV, R2. Sign and file a copy.

## 11. Disaster recovery

| Scenario | RTO | RPO | Procedure |
|----------|-----|-----|-----------|
| Worker deploy regression | 5 min | 0 | `wrangler rollback` |
| D1 logical corruption | 1 hr | 24 hr | restore latest dump (§4.2) into a new DB, re-bind, redeploy |
| KV namespace lost | 10 min | 0 | recreate; cache is rebuildable, rate limits self-heal |
| R2 covers lost | 1 hr | varies | re-upload from source masters; covers are not authoritative data |
| Total Cloudflare account loss | 1 day | 24 hr | restore from offsite backup into a fresh account |

Run a tabletop exercise of the D1-restore scenario at least once per year.
