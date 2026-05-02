#!/usr/bin/env node

/**
 * Reset Database Script
 *
 * Wipes all data from D1 (books, custom fields, transactions, codes, sync,
 * audits, FTS, attribute values, rooms). Schema and admin users are preserved.
 *
 * Usage:
 *   node scripts/reset_database.mjs --remote                  (production D1, prompts)
 *   node scripts/reset_database.mjs --remote --i-am-sure      (skips prompt)
 *   node scripts/reset_database.mjs                            (local wrangler)
 */

import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const isRemote = process.argv.includes('--remote');
const skipPrompt = process.argv.includes('--i-am-sure');

const sql = [
  // Order matters under FK constraints. Children first, parents last.
  'DELETE FROM book_attribute_values',
  'DELETE FROM sync_mutations',
  'DELETE FROM audit_logs',
  'DELETE FROM borrow_transactions',
  'DELETE FROM code_assignments',
  'DELETE FROM books',
  // The FTS5 table is kept in sync via triggers, but we clear it explicitly
  // so a partial-failure reset can still leave a clean index.
  'DELETE FROM books_fts',
  'DELETE FROM custom_field_definitions',
  'DELETE FROM rooms'
].join('; ') + ';';

async function confirmRemote() {
  if (!isRemote || skipPrompt) return true;
  // Production D1 wipes are irreversible. Require typed confirmation of the
  // exact phrase so muscle-memory `y` taps cannot trigger this. CI runs
  // should pass --i-am-sure explicitly.
  const rl = readline.createInterface({ input, output });
  console.error('\n⚠️  About to WIPE PRODUCTION D1 (--remote).');
  console.error('    This deletes ALL books, transactions, custom fields, audit logs.');
  console.error('    Type   DELETE PRODUCTION   to confirm, anything else to abort.\n');
  const reply = (await rl.question('> ')).trim();
  rl.close();
  return reply === 'DELETE PRODUCTION';
}

(async () => {
  if (!(await confirmRemote())) {
    console.error('Aborted.');
    process.exit(1);
  }

  console.log('🗑️  Resetting database...\n');
  console.log('SQL to execute:');
  console.log(sql);
  console.log('\n');

  try {
    const args = [
      'wrangler',
      'd1',
      'execute',
      'ok_library',
      '--config', 'apps/api-worker/wrangler.toml',
      '--command', sql
    ];

    if (isRemote) {
      args.push('--remote');
      console.log('🌐 Mode: PRODUCTION (remote D1)\n');
    } else {
      console.log('💻 Mode: LOCAL (wrangler)\n');
    }

    execFileSync('npx', args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' }
    });

    console.log('\n✅ Database reset complete!');
    console.log('   All data deleted. Schema preserved. FTS index cleared.');
    console.log('\nNext step:');
    console.log('   node scripts/import_xlsx_to_d1.mjs --file /path/to/LIBRARY_normalized.xlsx');
    console.log('   (add --remote for production)');
  } catch (err) {
    console.error('❌ Reset failed:', err.message);
    process.exit(1);
  }
})();
