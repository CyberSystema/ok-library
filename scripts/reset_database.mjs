#!/usr/bin/env node

/**
 * Reset Database Script
 * 
 * Completely wipes all data from D1 (books, custom fields, transactions, etc.)
 * Preserves only the schema and admin users
 * 
 * Usage:
 *   node scripts/reset_database.mjs --remote    (production D1)
 *   node scripts/reset_database.mjs             (local wrangler)
 */

import { execFileSync } from 'node:child_process';

const isRemote = process.argv.includes('--remote');

const sql = [
  'DELETE FROM sync_mutations',
  'DELETE FROM audit_logs',
  'DELETE FROM borrow_transactions',
  'DELETE FROM code_assignments',
  'DELETE FROM books',
  'DELETE FROM custom_field_definitions',
  'DELETE FROM rooms'
].join('; ') + ';';

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
  console.log('All data deleted. Schema preserved.');
  console.log('\nNext step: Run import to reload data');
} catch (err) {
  console.error('❌ Reset failed:', err.message);
  process.exit(1);
}
