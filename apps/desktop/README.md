# OK Library — Desktop (Electron shell)

A thin, hardened Electron wrapper around the existing `apps/web` SPA. It bundles
the locally-built web app and points it at the remote API.

## Why a desktop shell?

The web app's auth was a **cross-site cookie** (`pages.dev` ↔ `workers.dev`),
which Safari/WebKit ITP blocks — that's the "UI loads but no books" bug. This
shell sidesteps it two ways:

1. Electron renders with **Chromium**, so Safari ITP doesn't exist here.
2. More importantly, the web client now authenticates with **`Authorization:
   Bearer <token>`** (read from the login response body) — **no cookie at all**,
   so there's no cross-site/SameSite/partition/ITP problem on any platform.

## How it works

- The built SPA (`apps/web/dist`) is served over a custom **`app://ok-library`**
  scheme (a privileged, standard, secure origin) — not `file://`, which would
  break the SPA's absolute `/assets` paths and give no stable CORS origin.
- The renderer calls the remote API directly with a bearer token. The
  `app://ok-library` origin is allowlisted in the API's `CORS_ORIGIN`
  (`apps/api-worker/wrangler.toml`).
- Hardened: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, a strict
  CSP, and navigation / window-open allowlists (external links open in the real
  browser).

## Develop

```bash
npm install                 # from the repo root (installs the workspace)

# Option A — run against a Vite dev server (hot reload):
npm --workspace @ok-library/web run dev      # terminal 1 (http://localhost:5173)
npm --workspace @ok-library/desktop run dev  # terminal 2

# Option B — run against the production build:
npm --workspace @ok-library/desktop run build:web
npm --workspace @ok-library/desktop run start
```

> Dev mode (`OK_DESKTOP_DEV_URL`) loads `http://localhost:5173`. To talk to the
> production API from the dev server, that origin must also be in `CORS_ORIGIN`,
> or run the API locally and point `apps/web/.env` at it.

## Package

```bash
npm --workspace @ok-library/desktop run dist:mac   # .dmg + .zip
npm --workspace @ok-library/desktop run dist:win   # NSIS installer
```

### macOS signing & notarization

`electron-builder.yml` enables `hardenedRuntime` and references
`build/entitlements.mac.plist`. To produce a distributable (non-Gatekeeper-
blocked) build, set:

- `CSC_LINK` / `CSC_KEY_PASSWORD` — your Developer ID signing cert.
- `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, then flip
  `mac.notarize: true`.

## Auto-update

Wire `electron-updater` to a feed (GitHub Releases or an R2 bucket) and
uncomment the `publish:` block. Code signing is a prerequisite for update
integrity.

## Caveats

- The bundled `dist` pins a SPA version into the installer. If the API contract
  changes server-side, ship a desktop update too (or add a min-version check).
- Access tokens last 12h (`ACCESS_TOKEN_TTL_SECONDS`) and there's no refresh
  endpoint, so the app re-prompts for login on expiry.
