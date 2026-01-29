#!/usr/bin/env npx tsx

/**
 * Activate Additional Inboxes Daily
 *
 * Activates N inactive sender accounts for warmup.
 * Run daily at 5am before campaign sends start.
 *
 * Usage:
 *   npx tsx scripts/inbox-activate-daily.ts [--count N]
 *
 * Default: 2 accounts per day (12 emails/day capacity at 6/account)
 */

import { config } from 'dotenv';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();

const ACCOUNTS_TO_ACTIVATE = parseInt(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '2', 10);

async function activateAccounts() {
  console.log(`\n📧 Activating ${ACCOUNTS_TO_ACTIVATE} sender accounts...\n`);

  // Get current active count
  const activeResult = await pool.query(`
    SELECT COUNT(*) as count FROM sender_accounts WHERE status = 'active'
  `);
  const currentActive = parseInt(activeResult.rows[0].count, 10);
  console.log(`Current active accounts: ${currentActive}`);

  // Find inactive accounts that can be activated (have credentials)
  // Prioritize good email names: ryan@, ryan.heger@, ryanheger@, heger.ryan@, r.heger@
  const inactiveResult = await pool.query(`
    SELECT id, email, status, last_error
    FROM sender_accounts
    WHERE status IN ('disabled', 'error')
      AND credentials_encrypted IS NOT NULL
      AND provider = 'microsoft'
    ORDER BY
      CASE WHEN status = 'disabled' THEN 0 ELSE 1 END,
      CASE
        WHEN email LIKE 'ryan@%' THEN 1
        WHEN email LIKE 'ryan.heger@%' THEN 2
        WHEN email LIKE 'ryanheger@%' THEN 3
        WHEN email LIKE 'heger.ryan@%' THEN 4
        WHEN email LIKE 'r.heger@%' THEN 5
        WHEN email LIKE 'heger@%' THEN 6
        ELSE 10
      END,
      email
    LIMIT $1
  `, [ACCOUNTS_TO_ACTIVATE]);

  if (inactiveResult.rows.length === 0) {
    console.log('⚠️  No inactive accounts available to activate');
    await pool.end();
    return;
  }

  console.log(`Found ${inactiveResult.rows.length} accounts to activate:\n`);

  for (const account of inactiveResult.rows) {
    console.log(`  Activating: ${account.email} (was: ${account.status})`);

    await pool.query(`
      UPDATE sender_accounts
      SET status = 'active',
          enabled_for_sending = true,
          daily_limit = 6,
          emails_sent_today = 0,
          last_error = NULL,
          last_error_at = NULL,
          updated_at = NOW()
      WHERE id = $1
    `, [account.id]);
  }

  // Verify
  const newActiveResult = await pool.query(`
    SELECT COUNT(*) as count FROM sender_accounts WHERE status = 'active'
  `);
  const newActive = parseInt(newActiveResult.rows[0].count, 10);

  console.log(`\n✅ Activated ${inactiveResult.rows.length} accounts`);
  console.log(`Total active accounts: ${newActive} (capacity: ${newActive * 6} emails/day)\n`);

  await pool.end();
}

activateAccounts().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
