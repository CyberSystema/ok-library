#!/usr/bin/env node
/**
 * XLSX → D1 import.
 *
 * Two file formats are supported and auto-detected:
 *
 *   • Catalog format (LIBRARY_normalized.xlsx-style)
 *       Snake_case columns (id, title, authors, publisher, isbn_13, …).
 *       The script seeds the matching custom-field definitions automatically
 *       and upserts on `legacy_id`, so re-running the same xlsx UPDATES books
 *       in place instead of creating duplicates. The optional `review` sheet
 *       is read as a "needs review" overlay flag.
 *
 *   • Legacy format
 *       Mixed-case columns (Title, Writer, ISBN, Pages, Cover Type, …).
 *       Kept for back-compat. Skips rows missing both Title and Writer.
 *
 * Usage:
 *   node scripts/import_xlsx_to_d1.mjs --file <path/to/file.xlsx>
 *     [--batch 200]      Rows per SQL batch (default 200)
 *     [--remote]         Run against the production D1 (otherwise local)
 *     [--dry-run]        Parse + report only, don't write
 *     [--no-custom-fields]  Skip custom fields entirely (legacy format only)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('../apps/web/node_modules/xlsx');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function text(value, max = 2000) {
  if (value === null || value === undefined) return null;
  // NFC-normalize on entry. Korean (Hangul), Greek tonos, and Cyrillic data
  // routinely arrive in mixed normalization forms from Excel — joining
  // composed and decomposed forms breaks deduplication, search, and ISBN
  // lookups. Applying NFC at the boundary keeps the database in a single
  // canonical form so equality comparisons behave predictably.
  const t = String(value).normalize('NFC').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function num(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function boolish(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim().toLowerCase();
  if (!t) return null;
  if (['true', 'yes', '1', 'y'].includes(t)) return true;
  if (['false', 'no', '0', 'n'].includes(t)) return false;
  return null;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value).replaceAll("'", "''");
  return `'${s}'`;
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value));
}

function uuidExpr() {
  // Stable D1-side UUIDv4 emitter so each row gets its own id without a separate round-trip.
  return "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
}

function nowExpr() {
  return "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
}

function get(row, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) return row[k];
  }
  return null;
}

const CATALOG_MARKERS = [
  'authors', 'place_of_publication', 'category_code', 'source_sheet',
  'isbn_13', 'shelf_location', 'cover_type', 'has_illustrations'
];

// Mirror of CATALOG_CUSTOM_FIELDS in apps/api-worker/src/index.ts.
const CATALOG_CUSTOM_FIELDS = [
  ['series', 'Series', 'text'],
  ['volume_label', 'Volume Label', 'text'],
  ['volume_num', 'Volume Number', 'text'],
  ['editor', 'Editor', 'text'],
  ['translator', 'Translator', 'text'],
  ['place_of_publication', 'Place of Publication', 'text'],
  ['edition', 'Edition', 'text'],
  ['category_code', 'Category Code', 'text'],
  ['category_label', 'Category Label', 'text'],
  ['cover_type', 'Cover Type', 'text'],
  ['pages', 'Pages', 'number'],
  ['condition', 'Condition', 'text'],
  ['isbn_10', 'ISBN-10', 'text'],
  ['issn', 'ISSN', 'text'],
  ['additional_isbns', 'Additional ISBNs', 'text'],
  ['has_illustrations', 'Has Illustrations', 'boolean'],
  ['illustration_type', 'Illustration Type', 'text'],
  ['signed_copy', 'Signed Copy', 'boolean'],
  ['signature_notes', 'Signature Notes', 'text'],
  ['copies_count', 'Copies Count', 'number'],
  ['source_sheet', 'Source Sheet', 'text'],
  ['original_id', 'Original ID', 'text'],
  ['transformations_applied', 'Transformations Applied', 'text'],
  ['cleanup_notes', 'Cleanup Notes', 'text'],
  ['needs_review', 'Needs Review', 'boolean']
];

function isCatalogFormat(headers) {
  const set = new Set(headers.map((h) => String(h).trim().toLowerCase()));
  if (!set.has('id')) return false;
  return CATALOG_MARKERS.some((m) => set.has(m));
}

function buildCatalogRow(raw, reviewIds) {
  const row = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [String(k).trim().toLowerCase(), v])
  );
  if (Object.values(row).every((v) => text(v) === null)) return null;

  const legacyId = text(row.id, 64);
  const title = text(row.title, 300) || '(Untitled)';
  const author = text(row.authors, 300) || '(Unknown)';
  const isbn = text(row.isbn_13, 32) || text(row.isbn_10, 32) || null;
  const yr = num(row.published_year);
  const publicationYear = yr && yr >= 1000 && yr <= 3000 ? Math.round(yr) : null;

  const customFields = {};
  const put = (k, v) => {
    if (v !== null && v !== undefined && v !== '') customFields[k] = v;
  };
  put('series', text(row.series, 300));
  put('volume_label', text(row.volume_label, 300));
  put('volume_num', text(row.volume_num, 50));
  put('editor', text(row.editor, 300));
  put('translator', text(row.translator, 300));
  put('place_of_publication', text(row.place_of_publication, 200));
  put('edition', text(row.edition, 50));
  put('category_code', text(row.category_code, 32));
  put('category_label', text(row.category_label, 200));
  put('cover_type', text(row.cover_type, 50));
  const pages = num(row.pages);
  if (pages !== null) put('pages', pages);
  put('condition', text(row.condition, 200));
  put('isbn_10', text(row.isbn_10, 32));
  put('issn', text(row.issn, 32));
  put('additional_isbns', text(row.additional_isbns, 500));
  const hasIllus = boolish(row.has_illustrations);
  if (hasIllus !== null) put('has_illustrations', hasIllus);
  put('illustration_type', text(row.illustration_type, 200));
  const signed = boolish(row.signed_copy);
  if (signed !== null) put('signed_copy', signed);
  put('signature_notes', text(row.signature_notes, 500));
  const copies = num(row.copies_count);
  if (copies !== null) put('copies_count', copies);
  put('source_sheet', text(row.source_sheet, 50));
  put('original_id', text(row.original_id, 64));
  put('transformations_applied', text(row.transformations_applied, 1000));
  put('cleanup_notes', text(row.cleanup_notes, 1000));
  if (legacyId && reviewIds.has(legacyId)) put('needs_review', true);

  return {
    legacyId,
    title,
    author,
    isbn,
    publicationYear,
    publisher: text(row.publisher, 200),
    language: text(row.language, 120),
    description: text(row.description, 4000),
    shelfCode: text(row.shelf_location, 64),
    customFields
  };
}

function makeCatalogUpsertSql(row) {
  const now = nowExpr();
  return `
INSERT INTO books (
  id, title, author, isbn, publication_year, publisher, language, description,
  room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
  legacy_id, created_at, updated_at, deleted_at
) VALUES (
  ${uuidExpr()},
  ${sqlString(row.title)},
  ${sqlString(row.author)},
  ${sqlString(row.isbn)},
  ${row.publicationYear === null ? 'NULL' : String(row.publicationYear)},
  ${sqlString(row.publisher)},
  ${sqlString(row.language)},
  ${sqlString(row.description)},
  NULL,
  ${sqlString(row.shelfCode)},
  NULL,
  '[]',
  ${sqlJson(row.customFields)},
  'available',
  0,
  ${sqlString(row.legacyId)},
  ${now},
  ${now},
  NULL
)
ON CONFLICT(legacy_id) DO UPDATE SET
  title = excluded.title,
  author = excluded.author,
  isbn = excluded.isbn,
  publication_year = excluded.publication_year,
  publisher = excluded.publisher,
  language = excluded.language,
  description = excluded.description,
  shelf_code = excluded.shelf_code,
  custom_fields = excluded.custom_fields,
  updated_at = excluded.updated_at,
  version = books.version + 1,
  deleted_at = NULL;`;
}

function makeCatalogFieldDefSql() {
  // Idempotent seed via UPSERT on field_key UNIQUE.
  const now = nowExpr();
  return CATALOG_CUSTOM_FIELDS.map(([key, label, type]) => `
INSERT INTO custom_field_definitions
  (id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at)
VALUES (
  ${uuidExpr()},
  ${sqlString(key)},
  ${sqlString(label)},
  ${sqlString(type)},
  0,
  '[]',
  ${now},
  ${now},
  NULL
)
ON CONFLICT(field_key) DO UPDATE SET
  label = excluded.label,
  field_type = excluded.field_type,
  required = 0,
  enum_options = '[]',
  updated_at = excluded.updated_at,
  deleted_at = NULL;`).join('\n');
}

// ── Legacy mixed-case path (kept verbatim from previous version) ────────────

function normalizeLegacyRow(raw, skipCustomFields = false) {
  const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  const title = text(get(row, ['title']));
  const author = text(get(row, ['writer', 'author', 'writers']));
  if (!title || !author) return null;

  const customFields = {};
  if (!skipCustomFields) {
    const put = (key, value) => {
      if (value !== null && value !== undefined && value !== '') customFields[key] = value;
    };
    put('item', text(get(row, ['item'])));
    put('subTitle', text(get(row, ['sub title', 'subtitle'])));
    put('editor', text(get(row, ['editor'])));
    put('placeOfPublication', text(get(row, ['place of publication'])));
    put('publishedDate', text(get(row, ['published date'])));
    put('editionNumber', text(get(row, ['edition #', 'edition'])));
    put('category', text(get(row, ['category'])));
    put('translator', text(get(row, ['translator'])));
    put('coverType', text(get(row, ['cover type'])));
    put('condition', text(get(row, ['condition'])));
    put('pages', num(get(row, ['pages'])));
    put('numVolume', num(get(row, ['num. volume', 'num volume'])));
    put('color', text(get(row, ['color'])));
    put('signature', text(get(row, ['signature'])));
    put('moreCopies', num(get(row, ['more copies'])));
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('custom.') || k.startsWith('custom_')) {
        const key = k.replace(/^custom[._]/, '').trim();
        if (key) put(key, text(v));
      }
    }
  }

  const publicationYear = (() => {
    const rawYear = text(get(row, ['publicationyear']));
    if (rawYear) {
      const n = Number(rawYear);
      if (Number.isInteger(n) && n >= 1000 && n <= 3000) return n;
    }
    const publishedDate = text(get(row, ['published date']));
    if (publishedDate) {
      const match = publishedDate.match(/\b(\d{4})\b/);
      if (match) {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n >= 1000 && n <= 3000) return n;
      }
    }
    return null;
  })();

  return {
    title,
    author,
    isbn: text(get(row, ['isbn'])),
    publicationYear,
    publisher: text(get(row, ['publisher'])),
    language: text(get(row, ['language'])),
    description: text(get(row, ['description'])),
    shelfCode: text(get(row, ['shelf location', 'shelfcode'])),
    acquisitionDate: text(get(row, ['acquisitiondate'])),
    customFields
  };
}

function makeLegacyInsertSql(row) {
  const now = nowExpr();
  const title = sqlString(row.title);
  const author = sqlString(row.author);
  const isbn = sqlString(row.isbn);
  return `
INSERT INTO books (
  id, title, author, isbn, publication_year, publisher, language, description,
  room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
  legacy_id, created_at, updated_at, deleted_at
)
SELECT
  ${uuidExpr()}, ${title}, ${author}, ${isbn},
  ${row.publicationYear === null ? 'NULL' : String(row.publicationYear)},
  ${sqlString(row.publisher)}, ${sqlString(row.language)}, ${sqlString(row.description)},
  NULL, ${sqlString(row.shelfCode)}, ${sqlString(row.acquisitionDate)},
  '[]', ${sqlJson(row.customFields)}, 'available', 0,
  NULL, ${now}, ${now}, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM books b
  WHERE b.deleted_at IS NULL
    AND lower(trim(b.title)) = lower(trim(${title}))
    AND lower(trim(b.author)) = lower(trim(${author}))
    AND ((${isbn} IS NOT NULL AND b.isbn IS NOT NULL AND trim(b.isbn) = trim(${isbn})) OR (${isbn} IS NULL))
);`;
}

// ── Runner ──────────────────────────────────────────────────────────────────

function runD1Sql(sql, remote) {
  const tmpFile = path.join(os.tmpdir(), `oklib-import-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    const args = ['wrangler', 'd1', 'execute', 'ok_library', '--config', 'apps/api-worker/wrangler.toml', '--file', tmpFile];
    if (remote) args.push('--remote');
    execFileSync('npx', args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' }
    });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function main() {
  const filePath = arg('--file');
  const batchSize = Math.max(10, Number(arg('--batch', '200')));
  const remote = hasFlag('--remote');
  const dryRun = hasFlag('--dry-run');
  const skipCustomFields = hasFlag('--no-custom-fields');

  if (!filePath) {
    console.error('Usage: node scripts/import_xlsx_to_d1.mjs --file /path/to/lib.xlsx [--batch 200] [--remote] [--dry-run] [--no-custom-fields]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    console.error('Workbook has no sheets.');
    process.exit(1);
  }
  const sheet = workbook.Sheets[firstSheet];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  if (rawRows.length === 0) {
    console.error('Sheet has no data rows.');
    process.exit(1);
  }

  const headers = Object.keys(rawRows[0]);
  const catalog = isCatalogFormat(headers);

  if (catalog) {
    console.log('🧭 Detected: CATALOG FORMAT (snake_case columns, upsert on legacy_id)\n');

    // Optional review-overlay sheet.
    const reviewIds = new Set();
    const reviewSheetName = workbook.SheetNames.find((n) => String(n).trim().toLowerCase() === 'review');
    if (reviewSheetName) {
      const reviewRows = XLSX.utils.sheet_to_json(workbook.Sheets[reviewSheetName], { defval: null, raw: false });
      for (const r of reviewRows) {
        const idVal = r.id ?? r.ID ?? null;
        if (idVal !== null && idVal !== undefined && String(idVal).trim()) reviewIds.add(String(idVal).trim());
      }
      console.log(`  • review sheet: ${reviewIds.size} flagged IDs`);
    }

    const rows = [];
    let blank = 0;
    for (const raw of rawRows) {
      const r = buildCatalogRow(raw, reviewIds);
      if (!r) { blank += 1; continue; }
      rows.push(r);
    }

    const noTitle = rows.filter((r) => r.title === '(Untitled)').length;
    const noAuthor = rows.filter((r) => r.author === '(Unknown)').length;
    const reviewMatched = rows.filter((r) => r.customFields.needs_review === true).length;

    console.log(`  • rows in sheet:   ${rawRows.length}`);
    console.log(`  • valid rows:      ${rows.length}`);
    console.log(`  • blank rows:      ${blank}`);
    console.log(`  • empty title:     ${noTitle} (stored as "(Untitled)")`);
    console.log(`  • empty author:    ${noAuthor} (stored as "(Unknown)")`);
    console.log(`  • review-flagged:  ${reviewMatched}\n`);

    if (dryRun) {
      console.log('Dry run complete. No data was written.');
      return;
    }

    // Step 1: ensure custom field definitions exist.
    console.log('🔧 Seeding catalog custom field definitions...');
    runD1Sql(makeCatalogFieldDefSql(), remote);

    // Step 2: upsert books in batches.
    const batches = [];
    for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));

    console.log(`\n📚 Upserting ${rows.length} books in ${batches.length} batches of ~${batchSize}…`);
    for (let i = 0; i < batches.length; i += 1) {
      // Wrap each batch in a single transaction so a malformed row in the
      // middle of a batch rolls back the whole batch instead of leaving the
      // database half-imported. We don't span batches with one transaction
      // because a long-running write transaction can hit D1's per-request
      // size limits and would also block other writers.
      const inner = batches[i].map(makeCatalogUpsertSql).join('\n');
      const sql = `BEGIN;\n${inner}\nCOMMIT;`;
      console.log(`  batch ${i + 1}/${batches.length}  (${batches[i].length} rows)`);
      runD1Sql(sql, remote);
    }

    console.log('\n✅ Catalog import complete.');
    console.log('   Re-running this script with the same file is safe — books update in place via legacy_id.');
    return;
  }

  // ── Legacy path ───────────────────────────────────────────────────────────
  console.log('🧭 Detected: LEGACY FORMAT (Title/Writer columns)\n');
  const rows = rawRows.map((row) => normalizeLegacyRow(row, skipCustomFields)).filter(Boolean);
  if (rows.length === 0) {
    console.error('No valid rows with title+author found.');
    process.exit(1);
  }

  console.log(`  • rows in sheet:   ${rawRows.length}`);
  console.log(`  • valid rows:      ${rows.length}`);
  console.log(`  • skipped:         ${rawRows.length - rows.length}`);
  if (skipCustomFields) console.log('  • custom fields:   DISABLED');

  if (dryRun) {
    console.log('\nDry run complete. No data was written.');
    return;
  }

  const batches = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
  for (let i = 0; i < batches.length; i += 1) {
    const inner = batches[i].map(makeLegacyInsertSql).join('\n');
    const sql = `BEGIN;\n${inner}\nCOMMIT;`;
    console.log(`  batch ${i + 1}/${batches.length}  (${batches[i].length} rows)`);
    runD1Sql(sql, remote);
  }
  console.log('\n✅ Legacy import complete.');
}

main();
