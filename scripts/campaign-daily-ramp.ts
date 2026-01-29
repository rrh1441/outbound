#!/usr/bin/env npx tsx

/**
 * Daily Inbox Ramp-Up
 *
 * Enables additional inboxes and assigns only what's needed for today's send.
 * Designed for gradual warmup - add inboxes slowly to protect reputation.
 *
 * Usage:
 *   npm run campaign:daily-ramp -- --campaign-id <ID> [options]
 *
 * Options:
 *   --add <n>        Number of inboxes to enable (default: 2)
 *   --per-inbox <n>  Emails per inbox per day (default: 6)
 *   --dry-run        Preview without making changes
 *   --status         Show current state without changes
 */

import { config } from 'dotenv';
import { getPool, isSupabase, transaction } from '../lib/database.js';

config();

const pool = getPool();

interface SenderAccount {
  email: string;
  enabled_for_sending: boolean;
  daily_limit: number;
}

async function getInboxStatus(): Promise<{ enabled: SenderAccount[]; disabled: SenderAccount[] }> {
  const result = await pool.query<SenderAccount>(`
    SELECT email, enabled_for_sending, daily_limit
    FROM sender_accounts
    WHERE provider = 'microsoft'
      AND status = 'active'
    ORDER BY email
  `);

  const enabled = result.rows.filter(r => r.enabled_for_sending);
  const disabled = result.rows.filter(r => !r.enabled_for_sending);

  return { enabled, disabled };
}

async function getQueueStatus(campaignId: string): Promise<{ assigned: number; unassigned: number; sent: number }> {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('queued', 'sending') AND sender_email IS NOT NULL) as assigned,
      COUNT(*) FILTER (WHERE status IN ('queued', 'sending') AND sender_email IS NULL) as unassigned,
      COUNT(*) FILTER (WHERE status = 'sent') as sent
    FROM campaign_prospects
    WHERE campaign_id = $1
  `, [campaignId]);

  return {
    assigned: parseInt(result.rows[0].assigned) || 0,
    unassigned: parseInt(result.rows[0].unassigned) || 0,
    sent: parseInt(result.rows[0].sent) || 0
  };
}

async function enableInboxes(emails: string[], perInbox: number): Promise<void> {
  await pool.query(`
    UPDATE sender_accounts
    SET enabled_for_sending = true, daily_limit = $2
    WHERE email = ANY($1)
  `, [emails, perInbox]);
}

async function assignProspects(campaignId: string, limit: number): Promise<void> {
  // Get enabled senders (outside transaction - read-only)
  const sendersResult = await pool.query<{ email: string }>(`
    SELECT email FROM sender_accounts
    WHERE status = 'active' AND provider = 'microsoft' AND enabled_for_sending = true
    ORDER BY email
  `);
  const senders = sendersResult.rows;

  if (senders.length === 0) {
    console.log('   No enabled senders');
    return;
  }

  // Use transaction with row locking to prevent race conditions
  const result = await transaction(async (client) => {
    // Lock and select prospects atomically with FOR UPDATE SKIP LOCKED
    // This prevents concurrent processes from assigning the same prospects
    const prospectsResult = await client.query<{ id: string }>(`
      SELECT id FROM campaign_prospects
      WHERE campaign_id = $1
        AND status IN ('queued', 'sending')
        AND sender_email IS NULL
      ORDER BY scheduled_date ASC NULLS LAST, created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    `, [campaignId, limit]);

    const prospects = prospectsResult.rows;

    if (prospects.length === 0) {
      return { prospects: [], assignments: new Map<string, string[]>() };
    }

    // Round-robin assignment
    const assignments: Map<string, string[]> = new Map();
    senders.forEach(s => assignments.set(s.email, []));

    let senderIndex = 0;
    for (const prospect of prospects) {
      const email = senders[senderIndex % senders.length].email;
      assignments.get(email)!.push(prospect.id);
      senderIndex++;
    }

    // Batch update using UNNEST - single query for all assignments
    const prospectIds: string[] = [];
    const senderEmails: string[] = [];
    for (const [email, ids] of assignments) {
      for (const id of ids) {
        prospectIds.push(id);
        senderEmails.push(email);
      }
    }

    if (prospectIds.length > 0) {
      await client.query(`
        UPDATE campaign_prospects AS cp
        SET sender_email = batch.sender_email
        FROM (
          SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS sender_email
        ) AS batch
        WHERE cp.id = batch.id
      `, [prospectIds, senderEmails]);
    }

    return { prospects, assignments };
  });

  if (result.prospects.length === 0) {
    console.log('   No unassigned prospects to assign');
    return;
  }

  console.log(`   Assigned ${result.prospects.length} prospects:`);
  for (const [email, ids] of result.assignments) {
    if (ids.length > 0) {
      console.log(`     ${email}: ${ids.length}`);
    }
  }
}

async function dailyRamp(campaignId: string, options: {
  add: number;
  perInbox: number;
  dryRun: boolean;
  statusOnly: boolean;
}): Promise<void> {
  const { add, perInbox, dryRun, statusOnly } = options;

  console.log('\n📈 Daily Inbox Ramp-Up\n');
  console.log(`Database: ${isSupabase() ? 'Supabase (production)' : 'Local'}`);
  console.log(`Campaign: ${campaignId}\n`);

  // Get current state
  const { enabled, disabled } = await getInboxStatus();
  const queue = await getQueueStatus(campaignId);

  console.log('📊 Current State:');
  console.log(`   Inboxes: ${enabled.length} enabled, ${disabled.length} available to add`);
  console.log(`   Prospects: ${queue.assigned} assigned, ${queue.unassigned} in pool, ${queue.sent} sent`);
  console.log(`   Today's capacity: ${enabled.length} × ${perInbox} = ${enabled.length * perInbox} emails\n`);

  if (statusOnly) {
    if (enabled.length > 0) {
      console.log('📧 Enabled inboxes:');
      enabled.forEach(e => console.log(`   ✓ ${e.email}`));
    }
    if (disabled.length > 0) {
      console.log('\n📭 Next inboxes to enable:');
      disabled.slice(0, 5).forEach(e => console.log(`   ○ ${e.email}`));
      if (disabled.length > 5) console.log(`   ... and ${disabled.length - 5} more`);
    }
    console.log('');
    return;
  }

  // Calculate what to do
  const inboxesToAdd = disabled.slice(0, add);
  const newTotal = enabled.length + inboxesToAdd.length;
  const newCapacity = newTotal * perInbox;
  const toAssign = newCapacity - queue.assigned;

  console.log('📋 Plan:');
  if (inboxesToAdd.length > 0) {
    console.log(`   Enable ${inboxesToAdd.length} new inbox(es):`);
    inboxesToAdd.forEach(e => console.log(`     + ${e.email}`));
  } else {
    console.log('   No more inboxes to enable');
  }
  console.log(`   New capacity: ${newTotal} × ${perInbox} = ${newCapacity} emails`);
  console.log(`   Currently assigned: ${queue.assigned}`);
  console.log(`   Need to assign: ${Math.max(0, toAssign)} more from pool\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - no changes made\n');
    return;
  }

  // Execute
  if (inboxesToAdd.length > 0) {
    console.log('⚡ Enabling inboxes...');
    await enableInboxes(inboxesToAdd.map(e => e.email), perInbox);
    console.log(`   ✓ Enabled ${inboxesToAdd.length} inbox(es)`);
  }

  if (toAssign > 0) {
    console.log('\n📬 Assigning prospects...');
    await assignProspects(campaignId, toAssign);
  }

  // Final state
  const finalQueue = await getQueueStatus(campaignId);
  const { enabled: finalEnabled } = await getInboxStatus();

  console.log('\n✅ Done!');
  console.log(`   Inboxes enabled: ${finalEnabled.length}`);
  console.log(`   Prospects assigned: ${finalQueue.assigned}`);
  console.log(`   Ready to send: ${Math.min(finalQueue.assigned, finalEnabled.length * perInbox)} emails\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
📈 Daily Inbox Ramp-Up

Gradually add inboxes and assign only what's needed for each day's send.
Protects inbox reputation with controlled warmup.

Usage:
  npm run campaign:daily-ramp -- --campaign-id <ID> [options]

Required:
  --campaign-id <ID>   Campaign ID

Options:
  --add <n>            Number of inboxes to enable (default: 2)
  --per-inbox <n>      Emails per inbox per day (default: 6)
  --dry-run            Preview without making changes
  --status             Show current state only

Examples:
  # Check current state
  npm run campaign:daily-ramp -- --campaign-id campaign-123 --status

  # Preview tomorrow's ramp
  npm run campaign:daily-ramp -- --campaign-id campaign-123 --dry-run

  # Execute daily ramp (add 2 inboxes, assign what's needed)
  npm run campaign:daily-ramp -- --campaign-id campaign-123

  # Add 3 inboxes instead of 2
  npm run campaign:daily-ramp -- --campaign-id campaign-123 --add 3
    `);
    process.exit(0);
  }

  let campaignId = '';
  let add = 2;
  let perInbox = 6;
  let dryRun = false;
  let statusOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--add':
        add = parseInt(next);
        i++;
        break;
      case '--per-inbox':
        perInbox = parseInt(next);
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--status':
        statusOnly = true;
        break;
    }
  }

  if (!campaignId) {
    console.error('❌ Error: --campaign-id is required\n');
    process.exit(1);
  }

  try {
    await dailyRamp(campaignId, { add, perInbox, dryRun, statusOnly });
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
