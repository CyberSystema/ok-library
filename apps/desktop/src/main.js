// OK Library — Electron desktop shell (main process)
//
// Why this exists: the web app authenticates with a *cross-site* cookie
// (pages.dev ↔ workers.dev), which Safari/WebKit ITP blocks. Packaging the SPA
// in Electron sidesteps that entirely — Electron is Chromium (no ITP) AND the
// web client now authenticates with `Authorization: Bearer` (no cookie at all).
//
// Architecture:
//   • The locally-built SPA (apps/web/dist) is served over a custom, privileged
//     `app://ok-library` scheme — NOT file:// (which breaks the SPA's absolute
//     /assets paths and gives no stable Origin for CORS).
//   • The renderer talks directly to the remote API with a bearer token it gets
//     from the login response body. `app://ok-library` is allowlisted in the
//     API's CORS_ORIGIN (apps/api-worker/wrangler.toml).
//   • Hardened: contextIsolation on, nodeIntegration off, sandbox on, a strict
//     CSP, and navigation/window-open allowlists so the shell can't be turned
//     into an open browser.

const { app, BrowserWindow, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Brand name — keep the dock/menu/About consistent with the web app ("OK
// Library") even in dev, where productName from electron-builder doesn't apply.
app.setName('OK Library');

const APP_SCHEME = 'app';
const APP_HOST = 'ok-library';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_INDEX = `${APP_ORIGIN}/index.html`;

// Where the built SPA lives. In dev we run from source (apps/desktop/src ->
// apps/web/dist); when packaged, electron-builder copies it to resources/web/dist
// (see extraResources in electron-builder.yml).
const DIST_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'dist')
  : path.join(__dirname, '..', '..', 'web', 'dist');

// Remote API the renderer connects to. Keep in sync with apps/web/.env
// (VITE_API_BASE) and the API's CORS_ORIGIN allowlist.
const API_ORIGIN = 'https://ok-library-api.leontg.workers.dev';

// Optional dev override: `npm run dev` points this at the Vite dev server.
const DEV_URL = process.env.OK_DESKTOP_DEV_URL || null;

// Content-Security-Policy for the renderer. Mirrors what the SPA actually needs:
// its own assets, the remote API (connect + cover images), and Google Fonts.
const CSP = [
  `default-src 'self' ${APP_ORIGIN}`,
  `script-src 'self' ${APP_ORIGIN}`,
  // Vite injects a small inline style block; fonts CSS comes from Google.
  `style-src 'self' 'unsafe-inline' ${APP_ORIGIN} https://fonts.googleapis.com`,
  `font-src 'self' ${APP_ORIGIN} https://fonts.gstatic.com`,
  `img-src 'self' ${APP_ORIGIN} ${API_ORIGIN} data: blob:`,
  `connect-src 'self' ${APP_ORIGIN} ${API_ORIGIN} https://fonts.googleapis.com https://fonts.gstatic.com`,
  `base-uri 'none'`,
  `object-src 'none'`,
  `frame-ancestors 'none'`,
].join('; ');

// Register the custom scheme as a standard, secure, fetch-capable origin. Must
// run before `app.ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/** Map an app:// path to a file inside DIST_DIR, with traversal protection. */
function resolveDistFile(urlPathname) {
  const decoded = decodeURIComponent(urlPathname.split('?')[0] || '/');
  const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.normalize(path.join(DIST_DIR, rel));
  // Refuse anything that escapes DIST_DIR.
  if (full !== DIST_DIR && !full.startsWith(DIST_DIR + path.sep)) {
    return path.join(DIST_DIR, 'index.html');
  }
  return full;
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let filePath = resolveDistFile(url.pathname);
    // SPA fallback: unknown client-side routes resolve to index.html.
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function applySecurityHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

/** Only allow navigation within the app origin (or the dev server). External
 *  links open in the user's real browser instead of inside the shell. */
function lockDownNavigation(contents) {
  const allowedNavigation = new Set([APP_ORIGIN, DEV_URL].filter(Boolean));

  const isAllowed = (target) => {
    try {
      const u = new URL(target);
      return allowedNavigation.has(u.origin);
    } catch {
      return false;
    }
  };

  contents.on('will-navigate', (event, target) => {
    if (!isAllowed(target)) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Open http(s) links externally; deny everything else.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block attaching a webview and creating new BrowserWindows.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'OK Library',
    // Runtime window/taskbar icon (Windows + Linux). macOS uses the bundled
    // .icns from electron-builder. Matches the web app's book logo.
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  });

  lockDownNavigation(win.webContents);

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadURL(APP_INDEX);
  }

  return win;
}

app.whenReady().then(() => {
  registerAppProtocol();
  applySecurityHeaders();

  // macOS dock icon. The packaged .app uses the bundled .icns, but in dev
  // (`npm start`) the dock would otherwise show the default Electron icon —
  // set it at runtime so dev matches the web app's book logo too.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch { /* non-fatal */ }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Belt-and-suspenders: forbid any renderer from spawning a child process or
// navigating to a disallowed origin even if the per-window guard is bypassed.
app.on('web-contents-created', (_event, contents) => {
  lockDownNavigation(contents);
});
