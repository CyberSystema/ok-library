// Print-labels module: lazy-loaded only when the user clicks "Print labels".
//
// Renders a printable HTML page (opened in a new tab) where each book gets a
// sticker tile with: book title, author, legacy_id, and a QR code that encodes
// either the book's UUID URL or its existing scan code value.
//
// We use the `qrcode` package (~30 KB gzipped). Loading it lazily keeps the
// main bundle small.

type LabelTarget = {
  id: string;
  title: string;
  author: string;
  legacyId?: string | null;
  shelfCode?: string | null;
  isbn?: string | null;
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
  htmlLang: string;
};

const DEFAULT_LABEL_STRINGS: LabelStrings = {
  docTitle: 'Print labels',
  ready: 'labels ready to print',
  print: '🖨 Print',
  close: 'Close',
  toolbarHint: 'A4 · 3 columns · QR encodes a /api/scan link',
  popupBlocked: 'Pop-up blocked. Allow pop-ups for this site to print labels.',
  untitled: '(Untitled)',
  unknown: '(Unknown)',
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

  // Pre-render all QR codes to data URLs so the print window has them inline
  // and can fire a single window.print() once everything is loaded.
  const qrEntries = await Promise.all(
    books.map(async (b) => {
      const payload = `${apiBase}/api/scan/${encodeURIComponent(b.legacyId ?? b.id)}`;
      const dataUrl = await QRCode.toDataURL(payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6,
        color: { dark: '#000000', light: '#ffffff' }
      });
      return { book: b, dataUrl };
    })
  );

  const tilesHtml = qrEntries
    .map(({ book, dataUrl }) => {
      const meta: string[] = [];
      if (book.shelfCode) meta.push(escapeHtml(book.shelfCode));
      if (book.isbn) meta.push('ISBN ' + escapeHtml(book.isbn));
      const metaHtml = meta.length > 0 ? `<div class="meta">${meta.join(' · ')}</div>` : '';
      return `
        <article class="tile">
          <img src="${dataUrl}" alt="QR" />
          <div class="text">
            <div class="title">${escapeHtml(labelValue(book.title, '(Untitled)') || s.untitled)}</div>
            <div class="author">${escapeHtml(labelValue(book.author, '(Unknown)') || s.unknown)}</div>
            ${book.legacyId ? `<div class="lid">${escapeHtml(book.legacyId)}</div>` : ''}
            ${metaHtml}
          </div>
        </article>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="${escapeHtml(s.htmlLang)}">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(s.docTitle)} (${books.length})</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; }
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
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
    }
    .tile {
      border: 1px dashed #cbd5e1;
      border-radius: 6px;
      padding: 0.6rem;
      display: flex;
      gap: 0.6rem;
      align-items: center;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .tile img { width: 60px; height: 60px; flex-shrink: 0; }
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
    <strong>${books.length} ${escapeHtml(s.ready)}</strong>
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
