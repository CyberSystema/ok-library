// Print-labels module: lazy-loaded only when the user clicks "Print labels".
//
// Renders a printable HTML page (opened in a new tab). ONE TILE PER COPY, not
// per record: since the holdings layer a record can sit on two shelves, and a
// label identifies the physical thing on the shelf. A record with no copies
// loaded still gets one tile so nothing silently fails to print.
//
// Each tile carries both codes on purpose. The QR encodes a /api/scan link and
// is what a phone reads; the Code 128 encodes the copy's own barcode and is
// what a library scanner reads. Neither replaces the other.
//
// `qrcode` (~30 KB gzipped) is imported lazily. Code 128 has no dependency —
// see packages/shared/src/code128.ts for why it is written rather than pulled.

import { code128Svg } from '@ok-library/shared';

type LabelItem = {
  id: string;
  barcode?: string | null;
  copyNumber?: number | null;
  shelfCode?: string | null;
  volumeLabel?: string | null;
};

type LabelTarget = {
  id: string;
  title: string;
  author: string;
  legacyId?: string | null;
  shelfCode?: string | null;
  isbn?: string | null;
  items?: LabelItem[];
};

export type LabelStrings = {
  docTitle: string;
  ready: string;
  print: string;
  close: string;
  toolbarHint: string;
  popupBlocked: string;
  untitled: string;
  unknown: string;
  copyOf: string;
  noBarcode: string;
  htmlLang: string;
};

const DEFAULT_LABEL_STRINGS: LabelStrings = {
  docTitle: 'Print labels',
  ready: 'labels ready to print',
  print: '🖨 Print',
  close: 'Close',
  toolbarHint: 'A4 · 2 columns · one label per copy · QR + Code 128',
  popupBlocked: 'Pop-up blocked. Allow pop-ups for this site to print labels.',
  untitled: '(Untitled)',
  unknown: '(Unknown)',
  copyOf: 'copy {n}',
  noBarcode: 'no barcode assigned',
  htmlLang: 'en'
};

// Treat a blank value OR the legacy English sentinel ('(Untitled)'/'(Unknown)')
// as "no value" so stickers never carry a raw English placeholder under a Greek
// title — the caller supplies a localized fallback instead.
function labelValue(value: string | null | undefined, sentinel: string): string {
  const t = (value ?? '').trim();
  return t === sentinel ? '' : t;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function openPrintLabels(
  books: LabelTarget[],
  apiBase: string,
  strings: Partial<LabelStrings> = {}
): Promise<void> {
  const s: LabelStrings = { ...DEFAULT_LABEL_STRINGS, ...strings };
  // Tree-shakeable import; only the data-URL renderer is pulled in.
  const QRCode = (await import('qrcode')).default;

  // One tile per COPY. A record with no copies attached still gets a single
  // tile — some call paths carry items and some do not, and a print that
  // silently produced nothing would be the worst outcome.
  const targets = books.flatMap((book) =>
    (book.items && book.items.length > 0 ? book.items : [null]).map((item) => ({ book, item }))
  );

  // Pre-render all QR codes to data URLs so the print window has them inline
  // and can fire a single window.print() once everything is loaded. The QR
  // still points at the RECORD: a phone scan is "what is this book", and a
  // copy-level answer needs the Code 128 beside it.
  const rendered = await Promise.all(
    targets.map(async ({ book, item }) => {
      const payload = `${apiBase}/api/scan/${encodeURIComponent(item?.barcode ?? book.legacyId ?? book.id)}`;
      const dataUrl = await QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
        color: { dark: '#000000', light: '#ffffff' }
      });
      return { book, item, dataUrl };
    })
  );

  const tilesHtml = rendered
    .map(({ book, item, dataUrl }) => {
      const meta: string[] = [];
      // The COPY's shelf, not the record's: that is the whole point of a label
      // on a copy that sits on the back shelf.
      const shelf = item?.shelfCode ?? book.shelfCode;
      if (shelf) meta.push(escapeHtml(shelf));
      if (item?.copyNumber != null && (book.items?.length ?? 0) > 1) {
        meta.push(escapeHtml(s.copyOf.replace('{n}', String(item.copyNumber))));
      }
      if (item?.volumeLabel) meta.push(escapeHtml(item.volumeLabel));
      if (book.isbn) meta.push('ISBN ' + escapeHtml(book.isbn));
      const metaHtml = meta.length > 0 ? `<div class="meta">${meta.join(' · ')}</div>` : '';

      // Inline SVG rather than another raster data URI: it prints at printer
      // resolution instead of at the 60px the QR is rasterised to, which is the
      // difference between a barcode that scans and one that does not.
      const barcodeHtml = item?.barcode
        ? `<div class="barcode">${code128Svg(item.barcode, { moduleWidth: 1, height: 26, showText: true })}</div>`
        : `<div class="barcode nobc">${escapeHtml(s.noBarcode)}</div>`;

      return `
        <article class="tile">
          <div class="row">
            <img src="${dataUrl}" alt="" />
            <div class="text">
              <div class="title">${escapeHtml(labelValue(book.title, '(Untitled)') || s.untitled)}</div>
              <div class="author">${escapeHtml(labelValue(book.author, '(Unknown)') || s.unknown)}</div>
              ${book.legacyId ? `<div class="lid">${escapeHtml(book.legacyId)}</div>` : ''}
              ${metaHtml}
            </div>
          </div>
          ${barcodeHtml}
        </article>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="${escapeHtml(s.htmlLang)}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(s.docTitle)} (${targets.length})</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    /* An explicit white background, not the UA default: the sheet opens in a
       real browser window before it is printed, and a viewer in dark mode
       renders near-black behind text chosen for paper. */
    html, body {
      margin: 0; padding: 0; background: #fff; color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color-scheme: light;
    }
    .toolbar {
      position: sticky; top: 0; padding: 1rem 1.25rem; background: #f8fafc;
      border-bottom: 1px solid #e2e8f0; display: flex; gap: 0.75rem; align-items: center;
    }
    .toolbar button {
      background: #2563eb; color: white; border: none; padding: 0.5rem 0.95rem;
      border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer;
    }
    .toolbar button.secondary { background: white; color: #2563eb; border: 1.5px solid #cbd5e1; }
    .grid {
      padding: 1.5rem;
      display: grid;
      /* TWO columns, not three. A 3-up A4 tile is ~59mm wide and a Code 128
         needs ~26mm plus a 10-module quiet zone at each end; at 2-up the tile
         is ~91mm and the symbol has room to stay scannable. */
      grid-template-columns: repeat(2, 1fr);
      /*
       * A FIXED row height, so the sheet has one pitch.
       *
       * The tiles were sized by their content, and the content varies: a title clamped to
       * one line or two, a meta line present or absent, a legacy-id line, and a 36px
       * barcode versus a single line of "no barcode assigned". So the vertical pitch
       * drifted down the page — which makes the sheet scissors-only, since die-cut A4
       * sticker stock has a fixed pitch — and it drifted differently per LANGUAGE, because
       * Greek and Russian titles at ~1.3-1.4x hit the two-line clamp far more often than
       * English. The same six records produced a different sheet in each language.
       */
      grid-auto-rows: 37mm;
      gap: 0.75rem;
    }
    .tile {
      border: 1px dashed #cbd5e1;
      border-radius: 6px;
      padding: 0.6rem;
      display: flex;
      flex-direction: column;
      /* space-between pins the barcode to the bottom of every tile, so two stickers side
         by side have their symbols at the same height — the grid row stretched to the
         taller tile but nothing inside the shorter one grew, which left neighbouring
         barcodes 20-35px out of line. */
      justify-content: space-between;
      height: 37mm;
      overflow: hidden;
      gap: 0.4rem;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .tile .row { display: flex; gap: 0.6rem; align-items: center; }
    .tile img { width: 60px; height: 60px; flex-shrink: 0; }
    /* The barcode gets its own full-width row. Squeezing it beside the QR was
       the constraint that made a 24-character payload impossible. */
    .barcode { display: flex; justify-content: center; }
    /*
 * A PHYSICAL width, because a barcode is a physical object.
 *
 * max-width:100% let the symbol be laid out at whatever the tile happened to be, which
 * measured ~0.265mm per module — about 20% under the 0.33mm the encoder is designed
 * around, and under what a cheap desk scanner reliably reads. The module count is fixed
 * (8 digits pack to 99 modules in Code 128 subset C), so pinning the width pins the module
 * size: 33mm / 99 modules = 0.333mm.
 *
 * The viewBox stays in module units and moduleWidth stays at 1 — the gate asserts
 * viewBox="0 0 99", and it is right to: the SVG should describe the symbol and the
 * stylesheet should decide how big it is printed.
 */
.barcode svg { width: 33mm; max-width: 100%; height: auto; }
    .barcode.nobc { font-size: 0.6rem; color: #94a3b8; font-style: italic; }
    .text { flex: 1; min-width: 0; }
    .title {
      font-weight: 700; font-size: 0.78rem; line-height: 1.2;
      max-height: 2.4em; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .author { font-size: 0.7rem; color: #475569; margin-top: 0.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lid { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.65rem; color: #64748b; margin-top: 0.2rem; }
    .meta { font-size: 0.65rem; color: #64748b; margin-top: 0.1rem; }
    @media print {
      .toolbar { display: none; }
      .grid { padding: 0; gap: 4mm; }
      .tile { border-color: #94a3b8; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>${targets.length} ${escapeHtml(s.ready)}</strong>
    <button onclick="window.print()">${escapeHtml(s.print)}</button>
    <button class="secondary" onclick="window.close()">${escapeHtml(s.close)}</button>
    <span style="margin-left: auto; color: #64748b; font-size: 0.85rem;">${escapeHtml(s.toolbarHint)}</span>
  </div>
  <div class="grid">${tilesHtml}</div>
  <script>window.addEventListener('load', () => { setTimeout(() => window.print(), 250); });</script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    throw new Error(s.popupBlocked);
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
