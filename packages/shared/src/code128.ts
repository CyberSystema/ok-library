/**
 * Code 128 — the linear barcode library scanners actually read.
 *
 * Written here rather than pulled in: the repo's only code-generating
 * dependency is `qrcode`, which is 2D-only, and a barcode encoder is a lookup
 * table plus a weighted checksum. Adding a package for that would also have to
 * survive the desktop shell's `script-src 'self'` CSP and the lazy-chunk
 * boundary the label printer already lives behind.
 *
 * Lives in `shared` because both sides need it: the label sheet renders it
 * inline as SVG, and the Worker serves it from GET /api/items/:id/barcode.svg
 * so the regression gate can assert the module pattern against known vectors.
 * An encoder nobody can test is an encoder that prints unscannable labels.
 */

/**
 * Module widths for symbol values 0..106, as alternating bar/space runs
 * starting with a bar. Every entry is 11 modules except the stop (13).
 * 103 = Start A, 104 = Start B, 105 = Start C, 106 = Stop.
 */
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
] as const;

const START_B = 104;
const START_C = 105;
const STOP = 106;

/**
 * The symbol values for a payload.
 *
 * Subset C when the payload is an even-length run of digits — it packs two
 * digits into one symbol, which is the difference between a barcode that fits
 * beside the QR on a 59mm label tile and one that does not. Subset B otherwise,
 * so a value a librarian typed by hand still encodes.
 *
 * Deliberately not a full A/B/C shifting implementation: the payloads this
 * system mints are numeric by construction, and a half-correct shift table is
 * worse than a simple one.
 */
export function code128Values(payload: string): number[] {
  const numericC = /^\d+$/.test(payload) && payload.length % 2 === 0;
  const values: number[] = [numericC ? START_C : START_B];

  if (numericC) {
    for (let i = 0; i < payload.length; i += 2) values.push(Number(payload.slice(i, i + 2)));
  } else {
    for (const ch of payload) {
      const code = ch.charCodeAt(0);
      // Subset B covers ASCII 32..126. Anything else has no representation, and
      // silently dropping it would print a barcode that scans to the wrong id.
      if (code < 32 || code > 126) {
        throw new Error(`Code 128 subset B cannot encode ${JSON.stringify(ch)}`);
      }
      values.push(code - 32);
    }
  }

  // Mod-103 weighted checksum: the start value plus each data value times its
  // 1-based position. Mandatory — a scanner rejects the symbol without it.
  let sum = values[0];
  for (let i = 1; i < values.length; i += 1) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** The full module pattern as bar/space run widths, e.g. '211232' + …  */
export function code128Pattern(payload: string): string {
  return code128Values(payload).map((v) => CODE128_PATTERNS[v]).join('');
}

export interface Code128SvgOptions {
  /** Width of one module. 0.33mm is comfortably above the 0.25mm scanning floor. */
  moduleWidth?: number;
  height?: number;
  /** Print the payload under the bars, as every library label does. */
  showText?: boolean;
  /** Quiet zone in modules. The spec requires at least 10; less and it will not scan. */
  quietZone?: number;
}

/**
 * A self-contained SVG symbol.
 *
 * Vector rather than a raster data URI: it prints at printer resolution instead
 * of the 60px the QR is rasterised at, and the label sheet is already assembled
 * as an HTML string so markup drops straight in.
 */
export function code128Svg(payload: string, opts: Code128SvgOptions = {}): string {
  const mw = opts.moduleWidth ?? 1;
  const height = opts.height ?? 40;
  const quiet = opts.quietZone ?? 10;
  const showText = opts.showText ?? true;
  const textHeight = showText ? 10 : 0;

  const pattern = code128Pattern(payload);
  const modules = pattern.split('').reduce((n, d) => n + Number(d), 0);
  const width = (modules + quiet * 2) * mw;

  let x = quiet * mw;
  let isBar = true;
  const rects: string[] = [];
  for (const d of pattern) {
    const run = Number(d) * mw;
    // Only bars are drawn; the spaces are the background showing through.
    if (isBar) rects.push(`<rect x="${round(x)}" y="0" width="${round(run)}" height="${height}"/>`);
    x += run;
    isBar = !isBar;
  }

  const text = showText
    ? `<text x="${round(width / 2)}" y="${height + textHeight - 1}" text-anchor="middle"`
      + ` font-family="monospace" font-size="${textHeight}">${escapeXml(payload)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${height + textHeight}"`
    + ` width="${round(width)}" height="${height + textHeight}" role="img"`
    + ` aria-label="Barcode ${escapeXml(payload)}">`
    + `<rect width="100%" height="100%" fill="#fff"/>`
    + `<g fill="#000">${rects.join('')}</g>${text}</svg>`;
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] as string);
}

/**
 * The barcode value for a copy: an 8-digit zero-padded sequence.
 *
 * Numeric and even-length so subset C applies — 8 digits become 4 symbols, and
 * the whole symbol is 79 modules, about 26mm at 0.33mm. The label tile has
 * roughly 35mm free beside the QR, so it fits. The alphanumeric values
 * `generateCodeValue` mints are ~24 characters and would need ~75mm.
 *
 * No extra check digit: Code 128 carries a mandatory mod-103 checksum of its
 * own, and a second one would only make the payload longer.
 */
export function formatItemBarcode(sequence: number): string {
  return String(sequence).padStart(8, '0');
}
