#!/usr/bin/env node
/**
 * Back up the whole D1 database to files on disk.
 *
 * WHY THIS EXISTS: `wrangler d1 export` does not work on this database. It refuses with
 * "cannot export databases with Virtual Tables (fts5)", and `books_fts` is exactly that —
 * the full-text index migration 0012 added. So the one command everybody reaches for is
 * unavailable here, and until this script there was no backup of the catalogue at all: no
 * cron, no scheduled handler, no snapshot, nothing in the repo but `reset_database.mjs`,
 * which does the opposite. A librarian who deleted the wrong thing and emptied the trash had
 * no way back.
 *
 * WHAT IT DOES: reads every real table with SELECT only — it can never modify anything — and
 * writes one newline-delimited JSON file per table plus a manifest recording the row counts,
 * the schema DDL and which migrations had been applied. NDJSON rather than one big array so a
 * 12,700-row table streams and a truncated file still parses up to its last complete line.
 *
 * WHAT IT DOES NOT COVER: THE COVER IMAGES. They live in R2, not D1, and this tool never opens
 * the bucket. That is a deliberate boundary — a database dump and an object store are different
 * jobs — but it has to be said out loud, because "the first backup this catalogue has ever had"
 * invites the assumption that it holds everything. It does not:
 *
 *   · a cover is stored at one deterministic key, `covers/<bookId>.<ext>`;
 *   · uploading a replacement is a bare `put` to that key, so the old scan is overwritten;
 *   · the bucket has no object versioning;
 *   · therefore those bytes exist in exactly ONE place, and nothing can bring them back.
 *
 * The consequence is bounded — what is lost is one photograph of a book that is physically in the
 * building, and the remedy is to walk to the shelf and scan it again — which is why replacing a
 * cover asks for confirmation and names the book, rather than this script growing an object-store
 * mode. If that judgement ever stops holding (a rare-book collection photographed once, say),
 * `wrangler r2 object get` in a loop over these ids is the thing to write.
 *
 * WHAT IT SKIPS INSIDE D1, and why that is safe:
 *   · books_fts and its books_fts_* shadow tables — a derived index. The triggers rebuild it
 *     from `books`, and `POST /api/admin/rebuild-search-index` exists to force that. Backing
 *     up a derived index would only create a way for it to disagree with its source.
 *   · _cf_KV — Cloudflare's own bookkeeping, not ours.
 *   · d1_migrations is RECORDED in the manifest rather than dumped, because on restore the
 *     migrations should be applied by wrangler, not inserted as rows.
 *
 * USAGE
 *   node scripts/backup_d1.mjs --remote          # production (read-only)
 *   node scripts/backup_d1.mjs --local           # the dev database
 *   node scripts/backup_d1.mjs --remote --out /path/to/dir
 *   node scripts/backup_d1.mjs --remote --verify --out backups/production-...   # check one
 *
 * RESTORE is deliberately not automated here — it is rare, it is destructive, and it should be
 * done by someone reading the manifest. The procedure is in the manifest itself.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile, appendFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DB = 'ok_library';
const CONFIG = 'apps/api-worker/wrangler.toml';
const PAGE = 500;

// Anything derived, or Cloudflare's own. See the header for why each is safe to omit.
const SKIP = new Set(['_cf_KV', 'books_fts', 'books_fts_config', 'books_fts_data',
                      'books_fts_docsize', 'books_fts_idx', 'd1_migrations']);

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
if (remote === local) {
  console.error('Specify exactly one of --remote or --local.');
  process.exit(2);
}
const verifyOnly = args.includes('--verify');
const outIdx = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = outIdx >= 0 ? args[outIdx + 1] : join('backups', `${remote ? 'production' : 'local'}-${stamp}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One read-only query, retried.
 *
 * Rejects anything that is not a SELECT or PRAGMA — a second lock on top of the fact that
 * this tool only ever needs to read.
 *
 * The retry is not defensive padding: D1's HTTP API intermittently answers
 * `code: 7500 internal error` for a query that succeeds when repeated seconds later. This
 * backup makes hundreds of calls (23 tables, paged 500 rows at a time), so at that volume a
 * transient failure is not unlikely but expected — and a backup that aborts two thirds of the
 * way through, leaving a directory of plausible-looking partial files, is worse than one that
 * refuses to start. Five attempts with growing backoff, then a hard failure that says so.
 */
async function query(sql, attempt = 1) {
  const head = sql.trim().slice(0, 6).toUpperCase();
  if (head !== 'SELECT' && !sql.trim().toUpperCase().startsWith('PRAGMA')) {
    throw new Error(`refusing a non-read statement: ${sql.slice(0, 60)}`);
  }
  try {
    const { stdout } = await run('npx', [
      'wrangler', 'd1', 'execute', DB, remote ? '--remote' : '--local',
      '--config', CONFIG, '--json', '--command', sql
    ], { maxBuffer: 1024 * 1024 * 512 });
    return JSON.parse(stdout)[0].results;
  } catch (err) {
    if (attempt >= 5) {
      throw new Error(`gave up after ${attempt} attempts on: ${sql.slice(0, 90)}\n${err.message || err}`);
    }
    const wait = 800 * attempt;
    process.stdout.write(`    (D1 error, retry ${attempt} in ${wait}ms)\n`);
    await sleep(wait);
    return query(sql, attempt + 1);
  }
}

/**
 * Check a backup directory against the live database.
 *
 * An unverified backup is not a backup — it is a directory of files that look plausible. This
 * compares three numbers per table that must agree: what the manifest claims, what the
 * database holds now, and how many lines of the file actually parse as JSON. It also reports
 * DRIFT (live > backup) separately from CORRUPTION (file != manifest), because the first is
 * expected on a live catalogue and the second means the backup is unusable.
 */
async function verify(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  console.log(`verifying ${dir}\n  taken ${manifest.takenAt} from ${manifest.source}`);
  let corrupt = 0, drifted = 0;
  for (const [name, meta] of Object.entries(manifest.tables)) {
    const text = await readFile(join(dir, meta.file), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    let parsed = 0;
    for (const l of lines) { try { JSON.parse(l); parsed += 1; } catch { break; } }
    const live = (await query(`SELECT COUNT(*) AS n FROM "${name}"`))[0].n;
    const fileOk = lines.length === meta.rows && parsed === lines.length;
    const liveOk = live === meta.rows;
    if (!fileOk) corrupt += 1;
    else if (!liveOk) drifted += 1;
    const flag = !fileOk ? 'CORRUPT' : !liveOk ? 'drifted' : 'ok';
    console.log(`  ${name.padEnd(26)} manifest ${String(meta.rows).padStart(6)}  file ${String(lines.length).padStart(6)}  parsed ${String(parsed).padStart(6)}  live ${String(live).padStart(6)}  ${flag}`);
  }
  console.log('');
  if (corrupt) {
    console.error(`${corrupt} table(s) CORRUPT — this backup cannot be trusted.`);
    process.exit(1);
  }
  console.log(drifted
    ? `All files intact. ${drifted} table(s) have changed since the backup, which is normal for a live catalogue.`
    : 'All files intact and every table still matches the database exactly.');
}

async function main() {
  if (verifyOnly) { await verify(outDir); return; }
  await mkdir(outDir, { recursive: true });
  console.log(`backing up ${remote ? 'PRODUCTION' : 'local'} ${DB} -> ${outDir}`);

  // Deliberately NOT selecting sqlite_master.sql. The D1 HTTP API answers 7500 "internal
  // error" when that column is in the result set for this database, and the DDL is redundant
  // anyway: migrations 0001..N ARE the schema, and which ones were applied is recorded below.
  const objects = await query(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const migrations = await query('SELECT name, applied_at FROM d1_migrations ORDER BY id');

  const manifest = {
    database: DB,
    source: remote ? 'remote (production)' : 'local (dev)',
    takenAt: new Date().toISOString(),
    tool: 'scripts/backup_d1.mjs',
    note: 'wrangler d1 export cannot be used on this database: books_fts is an fts5 virtual table.',
    migrationsApplied: migrations,
    skipped: [...SKIP],
    tables: {},
    restore: [
      '1. Create or reset the target database, then apply migrations:',
      '     npx wrangler d1 migrations apply ok_library --remote --config apps/api-worker/wrangler.toml',
      '   The schema comes from the migrations, not from this backup: migrationsApplied above',
      '   records exactly which ones the data was written under. Do not',
      '   restore into a database at a LATER migration than that without checking the diff.',
      '2. Load each table from its .ndjson file, in the order given by tables[].restoreOrder',
      '   (parents before children, because the foreign keys are immediate).',
      '3. Rebuild the derived search index, which is deliberately not in this backup:',
      '     POST /api/admin/rebuild-search-index?force=1   (loop until done:true)',
      '4. Re-derive isbn_valid and the fold columns if the load bypassed the API:',
      '     POST /api/admin/normalize-books                (loop until done:true)',
      '5. Verify: row counts per table against tables[].rows below.'
    ]
  };

  // Parents before children, so a restore can honour the immediate foreign keys.
  const ORDER = [
    'staff_users', 'role_permissions', 'library_settings', 'loan_policies', 'rooms',
    'custom_field_definitions', 'authorities', 'authority_variants', 'borrowers',
    'books', 'items', 'book_attribute_values', 'book_authorities', 'book_sets',
    'serial_holdings', 'bound_with_items', 'code_assignments', 'borrow_transactions',
    'holds', 'book_vectorized', 'audit_logs', 'mutation_log', 'sync_mutations'
  ];
  const tables = objects.filter((o) => o.type === 'table' && !SKIP.has(o.name)).map((o) => o.name);

  // A table that exists but is not in ORDER would be dumped with no restore position, which
  // is how a new table quietly stops being restorable. Fail loudly instead.
  const unordered = tables.filter((t) => !ORDER.includes(t));
  if (unordered.length) {
    console.error(`\nERROR: these tables have no restore position in ORDER: ${unordered.join(', ')}`);
    console.error('Add them to ORDER in scripts/backup_d1.mjs (parents before children) and re-run.');
    process.exit(1);
  }

  let grandTotal = 0;
  for (const name of tables) {
    const file = join(outDir, `${name}.ndjson`);
    await writeFile(file, '');
    let after = 0, rows = 0;
    for (;;) {
      // Keyset paging on rowid, not OFFSET: an OFFSET walk over a table being written to can
      // skip or repeat rows, and a backup that silently skips a row is worse than no backup.
      const page = await query(
        `SELECT rowid AS __rid, * FROM "${name}" WHERE rowid > ${after} ORDER BY rowid LIMIT ${PAGE}`
      );
      if (!page.length) break;
      const lines = page.map((r) => {
        after = r.__rid;
        const { __rid, ...rest } = r;
        return JSON.stringify(rest);
      });
      await appendFile(file, lines.join('\n') + '\n');
      rows += page.length;
      if (page.length < PAGE) break;
    }
    const { size } = await stat(file);
    manifest.tables[name] = {
      rows, bytes: size, file: `${name}.ndjson`,
      restoreOrder: ORDER.indexOf(name)
    };
    grandTotal += rows;
    console.log(`  ${name.padEnd(26)} ${String(rows).padStart(7)} rows  ${(size / 1e6).toFixed(2)} MB`);
  }

  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`\n${tables.length} tables, ${grandTotal} rows total`);
  console.log(`manifest: ${join(outDir, 'manifest.json')}`);
  console.log('\nThe search index is NOT in this backup by design — it is rebuilt from books.');
  console.log('Keep these files somewhere that is not this laptop.');
}

main().catch((err) => {
  console.error('\nBACKUP FAILED — do not treat this directory as a backup.');
  console.error(err.message || err);
  process.exit(1);
});
