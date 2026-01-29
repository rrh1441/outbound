#!/usr/bin/env npx tsx

/**
 * Enable Additional Sender Accounts
 *
 * Enables N more sender accounts for campaign sending.
 * Use this to gradually ramp up sending capacity.
 *
 * Usage:
 *   npx tsx scripts/inbox-enable-senders.ts --count 2
 *   npx tsx scripts/inbox-enable-senders.ts --list
 */

import { config } from 'dotenv';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();

async function listAccounts() {
  const result = await pool.query(`
    SELECT email, status, enabled_for_sending, emails_sent_today, daily_limit
    FROM sender_accounts
    WHERE provider = 'microsoft'
    ORDER BY enabled_for_sending DESC, email
  `);

  console.log('\n📧 Sender Accounts\n');
  console.log('━'.repeat(90));
  console.log(
    'EMAIL'.padEnd(40) +
    'STATUS'.padEnd(10) +
    'SENDING'.padEnd(10) +
    'SENT/LIMIT'
  );
  console.log('━'.repeat(90));

  let enabledCount = 0;
  for (const row of result.rows) {
    const sending = row.enabled_for_sending ? '✅ Yes' : '❌ No';
    if (row.enabled_for_sending) enabledCount++;
    console.log(
      row.email.padEnd(40) +
      row.status.padEnd(10) +
      sending.padEnd(10) +
      `${row.emails_sent_today}/${row.daily_limit}`
    );
  }

  console.log('━'.repeat(90));
  console.log(`\nEnabled for sending: ${enabledCount}/${result.rows.length}`);
  console.log(`Daily capacity: ~${enabledCount * 6} emails (at 6/account)\n`);
}

async function enableMore(count: number) {
  // Get accounts not yet enabled, ordered by email for consistency
  const result = await pool.query(`
    SELECT email
    FROM sender_accounts
    WHERE provider = 'microsoft'
      AND status = 'active'
      AND enabled_for_sending = false
    ORDER BY email
    LIMIT $1
  `, [count]);

  if (result.rows.length === 0) {
    console.log('\n✅ All accounts are already enabled for sending!\n');
    return;
  }

  const emails = result.rows.map(r => r.email);

  await pool.query(`
    UPDATE sender_accounts
    SET enabled_for_sending = true
    WHERE email = ANY($1)
  `, [emails]);

  console.log(`\n✅ Enabled ${emails.length} additional sender(s):\n`);
  emails.forEach(e => console.log(`   + ${e}`));

  // Show new totals
  const totals = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE enabled_for_sending = true) as enabled,
      COUNT(*) as total
    FROM sender_accounts
    WHERE provider = 'microsoft' AND status = 'active'
  `);

  const { enabled, total } = totals.rows[0];
  console.log(`\nTotal enabled: ${enabled}/${total}`);
  console.log(`Daily capacity: ~${enabled * 6} emails\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Enable Sender Accounts

Usage:
  npx tsx scripts/inbox-enable-senders.ts [options]

Options:
  --list          List all accounts and their sending status
  --count N       Enable N more accounts for sending (default: 2)
  --help          Show this help

Examples:
  npx tsx scripts/inbox-enable-senders.ts --list
  npx tsx scripts/inbox-enable-senders.ts --count 2
    `);
    process.exit(0);
  }

  try {
    if (args.includes('--list')) {
      await listAccounts();
    } else {
      let count = 2; // default
      const countIdx = args.indexOf('--count');
      if (countIdx !== -1 && args[countIdx + 1]) {
        count = parseInt(args[countIdx + 1]) || 2;
      }
      await enableMore(count);
    }
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
