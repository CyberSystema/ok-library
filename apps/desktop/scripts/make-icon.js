// Generates the app icon (1024x1024 PNG) to match the web app's branding:
// the 📚 emoji on the brand-blue (#2563eb) rounded square (same as the web
// login logo / favicon). Rendered via Electron's Chromium so the emoji glyph
// and color match the web app exactly.
//
//   electron apps/desktop/scripts/make-icon.js [outPath]
//
// electron-builder picks up build/icon.png automatically and generates the
// platform .icns/.ico from it.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 1024;

// macOS "key line" grid: art sits in an ~824px rounded rect within 1024, corner
// radius ~185. Brand blue tile + centered book glyph.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${SIZE}px;height:${SIZE}px;background:transparent}
  .wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
  .tile{width:824px;height:824px;border-radius:185px;background:#2563eb;
        display:flex;align-items:center;justify-content:center}
  .glyph{font-size:470px;line-height:1;filter:drop-shadow(0 16px 28px rgba(0,0,0,0.18))}
</style></head><body>
  <div class="wrap"><div class="tile"><div class="glyph">📚</div></div></div>
</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  const sz = image.getSize();
  console.log(`wrote ${OUT} (${sz.width}x${sz.height})`);
  app.exit(0);
});
