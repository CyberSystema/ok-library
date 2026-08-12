#!/usr/bin/env node

/**
 * Wipe the catalogue data out of D1, keeping the schema and the accounts.
 *
 * This is the most destructive thing in the repository. It exists for one narrow purpose:
 * emptying a database before a fresh import. Everything below is about making sure it can
 * only ever do that on purpose.
 *
 * THREE THINGS CHANGED after an audit found this was a single line away from destroying the
 * whole catalogue:
 *
 *  1. `--i-am-sure` NO LONGER BYPASSES THE PROMPT ON `--remote`. It used to, so
 *     `node scripts/reset_database.mjs --remote --i-am-sure` wiped production with no
 *     confirmation, no backup and no way back — one line, pasteable, and easy to reach for by
 *     mistake or by an automation that meant to reset a dev database. docs/PRODUCTION_CHECKLIST.md
 *     stated the script was "locked behind a typed DELETE PRODUCTION confirmation", which was
 *     true only for the invocation nobody used. The flag is still honoured for `--local`,
 *     which is the dev loop it was actually added for.
 *
 *  2. A REMOTE WIPE TAKES A BACKUP FIRST and refuses to continue if it fails. D1 keeps 30 days
 *     of Time Travel, so a mistake here is recoverable in principle — but recovery needs
 *     someone to notice, and to know a timestamp from before the wipe. A file on disk needs
 *     neither. Pass `--backup <dir>` to point at a backup you have already taken and verified,
 *     or `--no-backup` to skip it, which has to be typed out.
 *
 *  3. THE TABLE LIST IS READ FROM THE DATABASE, not hardcoded. The old list named nine tables
 *     and the schema now has twenty-three. It had no idea `items` existed, so on today's
 *     schema `DELETE FROM books` fails outright on the foreign key from `items` — the "reset"
 *     stopped halfway and reported success for the statements that ran. Anything not in KEEP
 *     is deleted, so a table added by a future migration is included the day it appears
 *     instead of being quietly left behind holding rows that reference nothing.
 *
 * USAGE
 *   node scripts/reset_database.mjs                              # local
 *   node scripts/reset_database.mjs --i-am-sure                  # local, no prompt
 *   node scripts/reset_database.mjs --remote                     # backs up, then asks
 *   node scripts/reset_database.mjs --remote --backup backups/production-2026-08-12T09-00-00
 *   node scripts/reset_database.mjs --remote --no-backup         # asks, still
 */

import { execFileSync, execFile } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DB = 'ok_library';
const CONFIG = 'apps/api-worker/wrangler.toml';

const argv = process.argv.slice(2);
const isRemote = argv.includes('--remote');
const skipPrompt = argv.includes('--i-am-sure');
const noBackup = argv.includes('--no-backup');
const backupIdx = argv.indexOf('--backup');
const backupDir = backupIdx >= 0 ? argv[backupIdx + 1] : null;

/*
 * Configuration and people, not catalogue data. These survive a reset because an import
 * cannot recreate them: nobody can log in to run the import without staff_users, and
 * library_settings holds the library's own ISIL and name.
 *
 * rooms and custom_field_definitions are NOT here on purpose — the XLSX import rebuilds both
 * from the spreadsheet, and stale definitions from a previous shape are worse than none.
 */
const KEEP = new Set([
  'staff_users', 'role_permissions', 'library_settings', 'loan_policies',
  'd1_migrations', '_cf_KV'
]);

// Children before parents. A table found in the database but absent here aborts the run
// rather than being deleted in an arbitrary position, because the ordering is the whole
// reason this works under immediate foreign keys.
const ORDER = [
  'book_attribute_values', 'book_authorities', 'bound_with_items', 'serial_holdings',
  'holds', 'borrow_transactions', 'code_assignments', 'items', 'book_vectorized',
  'book_sets', 'sync_mutations', 'mutation_log', 'audit_logs', 'books',
  'authority_variants', 'authorities', 'borrowers', 'custom_field_definitions', 'rooms'
];

async function d1(sql, { json = false } = {}) {
  const args = ['wrangler', 'd1', 'execute', DB, isRemote ? '--remote' : '--local',
                '--config', CONFIG, ...(json ? ['--json'] : []), '--command', sql];
  const { stdout } = await run('npx', args, { maxBuffer: 1024 * 1024 * 64 });
  return json ? JSON.parse(stdout)[0].results : stdout;
}

/** Every real table in the database right now — the list this script must account for. */
async function liveTables() {
  const rows = await d1(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    { json: true }
  );
  return rows.map((r) => r.name).filter((n) => !n.startsWith('books_fts'));
}

async function confirm() {
  // Local: --i-am-sure is enough. It is a dev database that gets reset all day.
  if (!isRemote) {
    if (skipPrompt) return true;
    const rl = readline.createInterface({ input, output });
    const reply = (await rl.question('Wipe the LOCAL database? [y/N] > ')).trim().toLowerCase();
    rl.close();
    return reply === 'y' || reply === 'yes';
  }

  // Remote: the phrase is typed every time, whatever flags were passed. If this is not a
  // terminal there is nobody to type it, which is precisely when the wipe must not happen.
  if (!input.isTTY) {
    console.error('\nRefusing: --remote needs a typed confirmation and this is not a terminal.');
    console.error('There is no flag that skips it. Run it by hand, or do not run it.');
    return false;
  }
  const rl = readline.createInterface({ input, output });
  console.error('\n⚠️  About to WIPE PRODUCTION D1.');
  console.error('    Every book, copy, loan, reader, authority and audit entry is deleted.');
  if (skipPrompt) {
    console.error('    (--i-am-sure does NOT skip this on --remote. It never should have.)');
  }
  console.error('    Type   DELETE PRODUCTION   to confirm, anything else to abort.\n');
  const reply = (await rl.question('> ')).trim();
  rl.close();
  return reply === 'DELETE PRODUCTION';
}

/** A remote wipe gets a file on disk first, unless the operator typed --no-backup. */
async function ensureBackup() {
  if (!isRemote) return true;
  if (backupDir) {
    console.log(`Verifying the backup you named: ${backupDir}`);
    try {
      execFileSync('node', ['scripts/backup_d1.mjs', '--remote', '--verify', '--out', backupDir],
                   { stdio: 'inherit' });
      return true;
    } catch {
      console.error('\nThat backup does not verify. Not wiping anything.');
      return false;
    }
  }
  if (noBackup) {
    console.error('\n--no-backup: proceeding with no file on disk.');
    console.error('D1 Time Travel still covers the last 30 days, but recovery needs a');
    console.error('timestamp from before the wipe. Write down the time, now.');
    return true;
  }
  console.log('Taking a backup first (this is the only copy you will have).\n');
  try {
    execFileSync('node', ['scripts/backup_d1.mjs', '--remote'], { stdio: 'inherit' });
    return true;
  } catch {
    console.error('\nThe backup failed, so the wipe is cancelled. Fix the backup first.');
    return false;
  }
}

(async () => {
  const tables = await liveTables();
  const target = tables.filter((t) => !KEEP.has(t));

  // A table nobody has classified must not be silently kept OR silently deleted.
  const unplaced = target.filter((t) => !ORDER.includes(t));
  if (unplaced.length) {
    console.error(`\nRefusing: these tables exist but have no delete position: ${unplaced.join(', ')}`);
    console.error('Add them to ORDER in scripts/reset_database.mjs (children before parents),');
    console.error('or to KEEP if they hold configuration that should survive a reset.');
    process.exit(1);
  }

  const ordered = ORDER.filter((t) => target.includes(t));
  console.log(`${isRemote ? '🌐 PRODUCTION' : '💻 local'} ${DB}`);
  console.log(`  delete: ${ordered.join(', ')}`);
  console.log(`  keep:   ${tables.filter((t) => KEEP.has(t)).join(', ') || '(none)'}\n`);

  if (!(await ensureBackup())) process.exit(1);
  if (!(await confirm())) {
    console.error('Aborted. Nothing was deleted.');
    process.exit(1);
  }

  const sql = ordered.map((t) => `DELETE FROM "${t}"`).join('; ')
            + '; DELETE FROM books_fts;';

  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
                         '--config', CONFIG, '--command', sql,
                         ...(isRemote ? ['--remote'] : [])],
                 { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, CI: '1' } });
    console.log('\n✅ Data deleted. Schema, accounts and settings preserved.');
    console.log('\nNext step:');
    console.log('   node scripts/import_xlsx_to_d1.mjs --file /path/to/LIBRARY_normalized.xlsx');
    console.log('   (add --remote for production)');
  } catch (err) {
    // Partial failure is the dangerous case: some tables emptied, others not, so rows now
    // reference nothing. Say so plainly rather than reporting a clean reset.
    console.error('\n❌ Reset FAILED PART WAY THROUGH:', err.message);
    console.error('   The database may hold rows that reference deleted parents.');
    console.error('   Check row counts per table before doing anything else, and restore');
    console.error('   from the backup above if they are inconsistent.');
    process.exit(1);
  }
})();
