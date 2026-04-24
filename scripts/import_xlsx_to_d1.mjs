#!/usr/bin/env node
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

function text(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t.length ? t : null;
}

function num(value) {
  const t = text(value);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
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

function normalizeRow(raw, skipCustomFields = false) {
  const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k).trim().toLowerCase(), v]));

  const title = text(get(row, ['title']));
  const author = text(get(row, ['writer', 'author', 'writers']));
  if (!title || !author) {
    return null;
  }

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
    roomCode: text(get(row, ['roomcode'])),
    shelfCode: text(get(row, ['shelf location', 'shelfcode'])),
    acquisitionDate: text(get(row, ['acquisitiondate'])),
    tags: [],
    customFields,
    status: 'available'
  };
}

function makeInsertSql(row) {
  const now = nowExpr();
  const title = sqlString(row.title);
  const author = sqlString(row.author);
  const isbn = sqlString(row.isbn);

  return `
INSERT INTO books (
  id, title, author, isbn, publication_year, publisher, language, description,
  room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
  created_at, updated_at, deleted_at
)
SELECT
  ${uuidExpr()},
  ${title},
  ${author},
  ${isbn},
  ${row.publicationYear === null ? 'NULL' : String(row.publicationYear)},
  ${sqlString(row.publisher)},
  ${sqlString(row.language)},
  ${sqlString(row.description)},
  NULL,
  ${sqlString(row.shelfCode)},
  ${sqlString(row.acquisitionDate)},
  ${sqlJson(row.tags)},
  ${sqlJson(row.customFields)},
  ${sqlString(row.status)},
  0,
  ${now},
  ${now},
  NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM books b
  WHERE b.deleted_at IS NULL
    AND lower(trim(b.title)) = lower(trim(${title}))
    AND lower(trim(b.author)) = lower(trim(${author}))
    AND (
      (${isbn} IS NOT NULL AND b.isbn IS NOT NULL AND trim(b.isbn) = trim(${isbn}))
      OR (${isbn} IS NULL)
    )
);
`;
}

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
  const batchSize = Number(arg('--batch', '200'));
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
  const normalized = rawRows.map((row) => normalizeRow(row, skipCustomFields)).filter(Boolean);

  if (normalized.length === 0) {
    console.error('No valid rows with title+author found.');
    process.exit(1);
  }

  console.log(`Rows in sheet: ${rawRows.length}`);
  console.log(`Valid rows for import: ${normalized.length}`);
  console.log(`Skipped rows: ${rawRows.length - normalized.length}`);
  if (skipCustomFields) {
    console.log('⚠️  Custom fields disabled: importing only core fields');
  }

  if (dryRun) {
    console.log('Dry run complete. No data was written.');
    return;
  }

  const batches = [];
  for (let i = 0; i < normalized.length; i += batchSize) {
    batches.push(normalized.slice(i, i + batchSize));
  }

  for (let i = 0; i < batches.length; i += 1) {
    const sql = `${batches[i].map(makeInsertSql).join('\n')}\n`;
    console.log(`Importing batch ${i + 1}/${batches.length} (${batches[i].length} rows)...`);
    runD1Sql(sql, remote);
  }

  console.log('Import completed successfully.');
}

main();