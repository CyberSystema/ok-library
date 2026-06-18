// Preload — the only bridge between the renderer and the main process.
//
// The web app authenticates with a bearer token it reads from the login
// response body, so the desktop shell needs no privileged auth IPC today. We
// expose a tiny, read-only marker so the SPA can tell it's running inside the
// desktop shell (e.g. to tweak UX or, later, to route through main-process IPC).
//
// Keep this surface minimal: anything exposed here is reachable by any script
// running in the renderer.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('okDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
