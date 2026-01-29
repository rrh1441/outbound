#!/usr/bin/env npx tsx

/**
 * Pre-assign inboxes to prospects before scheduling
 *
 * Assigns sender accounts to campaign prospects so you know exactly
 * which inbox will send to which prospect. This enables proper reply handling.
 *
 * Usage:
 *   npm run campaign:assign-inboxes -- --campaign-id <ID> [options]
 *
 * Options:
 *   --dry-run           Preview assignments without saving
 *   --reassign          Clear existing assignments and reassign all queued
 *   --strategy <name>   Assignment strategy: round-robin (default), random, balanced
 *   --limit <n>         Only assign first N unassigned prospects
 */

import { config } from 'dotenv';
import { getPool, isSupabase } from '../lib/database.js';

config();

const pool = getPool();

interface SenderAccount {
  id: string;
  email: string;
  display_name: string | null;
  daily_limit: number;
  emails_sent_today: number;
}

interface Prospect {
  id: string;
  domain: string;
  company_name: string;
  contact_email: string;
}

async function getActiveSenders(): Promise<SenderAccount[]> {
  const result = await pool.query<SenderAccount>(`
    SELECT id, email, display_name, daily_limit, emails_sent_today
    FROM sender_accounts
    WHERE status = 'active'
      AND provider = 'microsoft'
      AND enabled_for_sending = true
    ORDER BY email
  `);
  return result.rows;
}

async function getUnassignedProspects(campaignId: string, limit?: number): Promise<Prospect[]> {
  const result = await pool.query<Prospect>(`
    SELECT id, domain, company_name, contact_email
    FROM campaign_prospects
    WHERE campaign_id = $1
      AND status IN ('queued', 'sending')
      AND sender_email IS NULL
    ORDER BY scheduled_date ASC NULLS LAST, created_at ASC
    LIMIT $2
  `, [campaignId, limit || 100000]);
  return result.rows;
}

async function getAllQueuedProspects(campaignId: string): Promise<Prospect[]> {
  const result = await pool.query<Prospect>(`
    SELECT id, domain, company_name, contact_email
    FROM campaign_prospects
    WHERE campaign_id = $1
      AND status IN ('queued', 'sending')
    ORDER BY scheduled_date ASC NULLS LAST, created_at ASC
  `, [campaignId]);
  return result.rows;
}

async function clearAssignments(campaignId: string): Promise<number> {
  const result = await pool.query(`
    UPDATE campaign_prospects
    SET sender_email = NULL
    WHERE campaign_id = $1
      AND status IN ('queued', 'sending')
    RETURNING id
  `, [campaignId]);
  return result.rowCount || 0;
}

async function saveAssignments(assignments: Map<string, string[]>): Promise<void> {
  for (const [senderEmail, prospectIds] of assignments) {
    if (prospectIds.length > 0) {
      await pool.query(`
        UPDATE campaign_prospects
        SET sender_email = $1
        WHERE id = ANY($2)
      `, [senderEmail, prospectIds]);
    }
  }
}

async function showCurrentAssignments(campaignId: string): Promise<void> {
  const result = await pool.query(`
    SELECT
      sender_email,
      COUNT(*) as count,
      array_agg(domain ORDER BY domain) as sample_domains
    FROM campaign_prospects
    WHERE campaign_id = $1
      AND status IN ('queued', 'sending')
      AND sender_email IS NOT NULL
    GROUP BY sender_email
    ORDER BY sender_email
  `, [campaignId]);

  if (result.rows.length === 0) {
    console.log('   No assignments yet');
    return;
  }

  for (const row of result.rows) {
    const samples = row.sample_domains.slice(0, 3).join(', ');
    const more = row.sample_domains.length > 3 ? ` (+${row.sample_domains.length - 3} more)` : '';
    console.log(`   ${row.sender_email}: ${row.count} prospects`);
    console.log(`      e.g. ${samples}${more}`);
  }
}

async function assignInboxes(
  campaignId: string,
  strategy: 'round-robin' | 'random' | 'balanced',
  options: { dryRun: boolean; reassign: boolean; limit?: number }
): Promise<void> {
  console.log('\n📮 Inbox Assignment Tool\n');
  console.log(`Database: ${isSupabase() ? 'Supabase (production)' : 'Local'}`);

  // Load senders
  const senders = await getActiveSenders();
  if (senders.length === 0) {
    console.error('\n❌ No active sender accounts found');
    console.log('   Configure accounts with: npm run inbox:add-account\n');
    process.exit(1);
  }

  console.log(`\n📧 Available senders (${senders.length}):`);
  for (const s of senders) {
    console.log(`   ${s.email} (${s.emails_sent_today}/${s.daily_limit} today)`);
  }

  // Show current state
  console.log('\n📊 Current assignments:');
  await showCurrentAssignments(campaignId);

  // Clear existing if reassign
  if (options.reassign) {
    if (options.dryRun) {
      console.log('\n🔄 [DRY RUN] Would clear existing assignments');
    } else {
      const cleared = await clearAssignments(campaignId);
      console.log(`\n🔄 Cleared ${cleared} existing assignments`);
    }
  }

  // Get prospects to assign
  const prospects = options.reassign
    ? await getAllQueuedProspects(campaignId)
    : await getUnassignedProspects(campaignId, options.limit);

  console.log(`\n📋 Prospects to assign: ${prospects.length}`);

  if (prospects.length === 0) {
    console.log('✅ All prospects already have inbox assignments\n');
    return;
  }

  // Build assignments based on strategy
  const assignments: Map<string, string[]> = new Map();
  for (const s of senders) {
    assignments.set(s.email, []);
  }

  let senderIndex = 0;
  for (const prospect of prospects) {
    let senderEmail: string;

    if (strategy === 'round-robin') {
      senderEmail = senders[senderIndex % senders.length].email;
      senderIndex++;
    } else if (strategy === 'random') {
      senderEmail = senders[Math.floor(Math.random() * senders.length)].email;
    } else {
      // Balanced: assign to sender with fewest assignments
      const sorted = [...assignments.entries()].sort((a, b) => a[1].length - b[1].length);
      senderEmail = sorted[0][0];
    }

    assignments.get(senderEmail)!.push(prospect.id);
  }

  // Display planned assignments
  console.log(`\n📊 Planned assignments (${strategy}):`);
  for (const [email, ids] of assignments) {
    if (ids.length > 0) {
      console.log(`   ${email}: ${ids.length} prospects`);
    }
  }

  if (options.dryRun) {
    console.log('\n🧪 DRY RUN - no changes saved\n');
    return;
  }

  // Save assignments
  console.log('\n💾 Saving assignments...');
  await saveAssignments(assignments);

  console.log('✅ Done\n');

  // Show final state
  console.log('📊 Final assignments:');
  await showCurrentAssignments(campaignId);
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
📮 Inbox Assignment Tool

Pre-assign sender inboxes to campaign prospects so you know exactly
which inbox will send to which prospect.

Usage:
  npm run campaign:assign-inboxes -- --campaign-id <ID> [options]

Required:
  --campaign-id <ID>     Campaign ID to assign inboxes for

Options:
  --dry-run              Preview assignments without saving
  --reassign             Clear existing assignments and reassign all queued
  --strategy <name>      Assignment strategy (default: round-robin)
                         - round-robin: distribute evenly in order
                         - random: random assignment
                         - balanced: always assign to least-used inbox
  --limit <n>            Only assign first N unassigned prospects

Examples:
  # Preview assignments
  npm run campaign:assign-inboxes -- --campaign-id campaign-123 --dry-run

  # Assign inboxes (round-robin)
  npm run campaign:assign-inboxes -- --campaign-id campaign-123

  # Reassign all with balanced strategy
  npm run campaign:assign-inboxes -- --campaign-id campaign-123 --reassign --strategy balanced

  # Assign only 18 prospects
  npm run campaign:assign-inboxes -- --campaign-id campaign-123 --limit 18
    `);
    process.exit(0);
  }

  let campaignId = '';
  let dryRun = false;
  let reassign = false;
  let strategy: 'round-robin' | 'random' | 'balanced' = 'round-robin';
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--reassign':
        reassign = true;
        break;
      case '--strategy':
        if (['round-robin', 'random', 'balanced'].includes(next)) {
          strategy = next as 'round-robin' | 'random' | 'balanced';
        } else {
          console.error(`❌ Unknown strategy: ${next}`);
          process.exit(1);
        }
        i++;
        break;
      case '--limit':
        limit = parseInt(next);
        i++;
        break;
    }
  }

  if (!campaignId) {
    console.error('❌ Error: --campaign-id is required\n');
    process.exit(1);
  }

  try {
    await assignInboxes(campaignId, strategy, { dryRun, reassign, limit });
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
