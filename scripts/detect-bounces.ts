#!/usr/bin/env npx tsx

/**
 * Bounce Detection Script
 *
 * Scans Gmail for bounce notifications and updates campaign_prospects
 * with bounce information. Tracks bounces separately for catch-all vs
 * verified emails.
 *
 * Usage:
 *   npx tsx scripts/detect-bounces.ts [--days 7] [--dry-run]
 */

import { config } from 'dotenv';
import { createGmailClientFromEnv } from '../apps/campaigns/core/gmail-client.js';
import { getPool } from '../lib/database.js';

config();

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

// Bounce detection patterns
const BOUNCE_SENDERS = [
  'mailer-daemon@',
  'postmaster@',
  'mail-daemon@',
  'noreply@',
  'MAILER-DAEMON@'
];

const HARD_BOUNCE_PATTERNS = [
  /user.*not.*found/i,
  /user.*unknown/i,
  /mailbox.*not.*found/i,
  /address.*rejected/i,
  /invalid.*recipient/i,
  /no.*such.*user/i,
  /recipient.*rejected/i,
  /account.*disabled/i,
  /account.*not.*exist/i,
  /550.*5\.1\.1/,  // User unknown
  /550.*5\.1\.2/,  // Bad destination mailbox
  /550.*permanent/i,
  /delivery.*failed.*permanently/i
];

const SOFT_BOUNCE_PATTERNS = [
  /mailbox.*full/i,
  /over.*quota/i,
  /temporarily.*rejected/i,
  /try.*again.*later/i,
  /service.*unavailable/i,
  /connection.*timed.*out/i,
  /452.*4\.2\.2/,  // Mailbox full
  /421.*service/i,
  /temporary.*failure/i
];

interface BounceInfo {
  email: string;
  bounceType: 'hard' | 'soft' | 'unknown';
  bounceReason: string;
  bounceCode: string | null;
  messageId: string;
  rawSnippet: string;
}

function extractEmailFromBounce(body: string): string | null {
  // Common patterns for bounced email addresses
  const patterns = [
    /<([^>]+@[^>]+)>/,  // <email@domain.com>
    /to:?\s*([^\s<>]+@[^\s<>]+)/i,
    /recipient:?\s*([^\s<>]+@[^\s<>]+)/i,
    /address:?\s*([^\s<>]+@[^\s<>]+)/i,
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      const email = match[1].toLowerCase();
      // Filter out common system addresses
      if (!email.includes('mailer-daemon') &&
          !email.includes('postmaster') &&
          !email.startsWith('noreply')) {
        return email;
      }
    }
  }

  return null;
}

function classifyBounce(body: string): { type: 'hard' | 'soft' | 'unknown'; reason: string; code: string | null } {
  const bodyLower = body.toLowerCase();

  // Check for hard bounce patterns
  for (const pattern of HARD_BOUNCE_PATTERNS) {
    if (pattern.test(body)) {
      const match = body.match(/5\d{2}\s+5\.\d+\.\d+/);
      return {
        type: 'hard',
        reason: body.slice(0, 200),
        code: match ? match[0] : null
      };
    }
  }

  // Check for soft bounce patterns
  for (const pattern of SOFT_BOUNCE_PATTERNS) {
    if (pattern.test(body)) {
      const match = body.match(/4\d{2}\s+4\.\d+\.\d+/);
      return {
        type: 'soft',
        reason: body.slice(0, 200),
        code: match ? match[0] : null
      };
    }
  }

  return {
    type: 'unknown',
    reason: body.slice(0, 200),
    code: null
  };
}

async function detectBounces(options: { days: number; dryRun: boolean }) {
  const { days, dryRun } = options;

  console.log('\n🔍 Bounce Detection Script\n');
  console.log(`   Looking back: ${days} days`);
  console.log(`   Dry run: ${dryRun}\n`);

  // Initialize Gmail client
  console.log('🔐 Initializing Gmail client...');
  const gmailClient = createGmailClientFromEnv();
  await gmailClient.refreshAccessToken();
  console.log('✅ Gmail authenticated\n');

  // Calculate date range
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - days);
  const afterDateStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

  // Search for bounce messages
  const searchQuery = `from:(mailer-daemon OR postmaster) after:${afterDateStr}`;
  console.log(`📧 Searching: ${searchQuery}\n`);

  const messages = await gmailClient.listMessages(searchQuery, 100);

  if (!messages || messages.length === 0) {
    console.log('✅ No bounce messages found.\n');
    await pool.end();
    return;
  }

  console.log(`📬 Found ${messages.length} potential bounce messages\n`);

  const bounces: BounceInfo[] = [];
  let processed = 0;

  for (const msg of messages) {
    try {
      const fullMessage = await gmailClient.getMessage(msg.id);
      const snippet = fullMessage.snippet || '';
      const payload = fullMessage.payload;

      // Extract body
      let body = snippet;
      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      } else if (payload?.parts) {
        for (const part of payload.parts) {
          if (part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
          }
        }
      }

      // Extract bounced email
      const bouncedEmail = extractEmailFromBounce(body);
      if (!bouncedEmail) {
        continue;
      }

      // Classify bounce type
      const classification = classifyBounce(body);

      bounces.push({
        email: bouncedEmail,
        bounceType: classification.type,
        bounceReason: classification.reason,
        bounceCode: classification.code,
        messageId: msg.id,
        rawSnippet: snippet.slice(0, 300)
      });

      processed++;

    } catch (error: any) {
      console.error(`   Error processing message ${msg.id}: ${error.message}`);
    }
  }

  console.log(`\n📊 Processed ${processed} messages, found ${bounces.length} bounces\n`);

  if (bounces.length === 0) {
    console.log('✅ No actionable bounces detected.\n');
    await pool.end();
    return;
  }

  // Group by bounce type
  const hardBounces = bounces.filter(b => b.bounceType === 'hard');
  const softBounces = bounces.filter(b => b.bounceType === 'soft');
  const unknownBounces = bounces.filter(b => b.bounceType === 'unknown');

  console.log('━'.repeat(60));
  console.log('\n📋 Bounce Summary:\n');
  console.log(`   Hard bounces: ${hardBounces.length}`);
  console.log(`   Soft bounces: ${softBounces.length}`);
  console.log(`   Unknown: ${unknownBounces.length}\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - Would update the following:\n');
  }

  // Update database
  let updated = 0;
  let logged = 0;
  let notFound = 0;
  let catchAllBounces = 0;
  let verifiedBounces = 0;

  for (const bounce of bounces) {
    console.log(`📧 ${bounce.email}`);
    console.log(`   Type: ${bounce.bounceType}`);
    console.log(`   Code: ${bounce.bounceCode || 'N/A'}`);

    if (dryRun) {
      console.log('   [DRY RUN - not updating]\n');
      continue;
    }

    try {
      // Find the prospect
      const prospectResult = await pool.query(`
        SELECT id, is_catch_all FROM campaign_prospects
        WHERE LOWER(contact_email) = LOWER($1)
        AND status IN ('sent', 'delivered')
        LIMIT 1
      `, [bounce.email]);

      if (prospectResult.rows.length === 0) {
        console.log('   ⚠️  Not found in campaign_prospects\n');
        notFound++;
        continue;
      }

      const prospect = prospectResult.rows[0];
      const isCatchAll = prospect.is_catch_all || false;

      if (isCatchAll) {
        catchAllBounces++;
      } else {
        verifiedBounces++;
      }

      // Update prospect status
      await pool.query(`
        UPDATE campaign_prospects
        SET
          status = 'bounced',
          bounce_type = $2,
          bounced_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `, [prospect.id, bounce.bounceType]);

      updated++;

      // Log to bounce_log table
      await pool.query(`
        INSERT INTO email_bounce_log (
          prospect_id,
          campaign_id,
          email,
          is_catch_all,
          bounce_type,
          bounce_reason,
          bounce_code,
          raw_response
        )
        SELECT
          id,
          campaign_id,
          contact_email,
          $2,
          $3,
          $4,
          $5,
          $6
        FROM campaign_prospects
        WHERE id = $1
      `, [
        prospect.id,
        isCatchAll,
        bounce.bounceType,
        bounce.bounceReason.slice(0, 500),
        bounce.bounceCode,
        JSON.stringify({ snippet: bounce.rawSnippet, gmail_message_id: bounce.messageId })
      ]);

      logged++;

      console.log(`   ✅ Updated (${isCatchAll ? 'catch-all' : 'verified'})\n`);

    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}\n`);
    }
  }

  console.log('━'.repeat(60));
  console.log('\n📊 Update Summary:\n');
  console.log(`   Prospects updated: ${updated}`);
  console.log(`   Bounce logs created: ${logged}`);
  console.log(`   Not found: ${notFound}`);
  console.log(`\n   By email type:`);
  console.log(`   - Verified bounces: ${verifiedBounces}`);
  console.log(`   - Catch-all bounces: ${catchAllBounces}`);

  // Show updated stats
  const stats = await pool.query(`SELECT * FROM catch_all_bounce_stats`);
  if (stats.rows.length > 0) {
    console.log('\n📈 Updated Bounce Rates:\n');
    for (const row of stats.rows) {
      console.log(`   ${row.email_type}: ${row.total_sent} sent, ${row.bounced} bounced (${row.bounce_rate_pct}%)`);
    }
  }

  console.log('');
  await pool.end();
}

async function showStats() {
  console.log('\n📊 Bounce Statistics\n');

  const stats = await pool.query(`SELECT * FROM catch_all_bounce_stats`);

  if (stats.rows.length === 0) {
    console.log('   No send data yet.\n');
    await pool.end();
    return;
  }

  console.log('━'.repeat(50));
  console.log(`${'Email Type'.padEnd(15)} ${'Sent'.padStart(8)} ${'Bounced'.padStart(8)} ${'Rate'.padStart(8)}`);
  console.log('━'.repeat(50));

  for (const row of stats.rows) {
    console.log(
      `${row.email_type.padEnd(15)} ` +
      `${String(row.total_sent).padStart(8)} ` +
      `${String(row.bounced).padStart(8)} ` +
      `${(row.bounce_rate_pct + '%').padStart(8)}`
    );
  }

  console.log('━'.repeat(50));

  // Show recent bounces
  const recentBounces = await pool.query(`
    SELECT email, bounce_type, is_catch_all, detected_at
    FROM email_bounce_log
    ORDER BY detected_at DESC
    LIMIT 10
  `);

  if (recentBounces.rows.length > 0) {
    console.log('\n📋 Recent Bounces:\n');
    for (const row of recentBounces.rows) {
      const date = new Date(row.detected_at).toLocaleDateString();
      const type = row.is_catch_all ? '🔄' : '✅';
      console.log(`   ${type} ${row.email} - ${row.bounce_type} (${date})`);
    }
  }

  console.log('');
  await pool.end();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Bounce Detection Script - Scan Gmail for bounces and update tracking

Usage:
  npx tsx scripts/detect-bounces.ts [options]

Options:
  --days <n>      Look back N days for bounces (default: 7)
  --dry-run       Preview bounces without updating database
  --stats         Show current bounce statistics only

Environment Variables:
  CATCH_ALL_BOUNCE_THRESHOLD  Pause catch-all if bounce rate exceeds this % (default: 5)
  CATCH_ALL_MIN_SAMPLE_SIZE   Minimum sends before enforcing threshold (default: 20)

Examples:
  # Detect bounces from last 7 days
  npx tsx scripts/detect-bounces.ts

  # Check last 14 days, dry run
  npx tsx scripts/detect-bounces.ts --days 14 --dry-run

  # Show statistics only
  npx tsx scripts/detect-bounces.ts --stats
    `);
    process.exit(0);
  }

  if (args.includes('--stats')) {
    await showStats();
    return;
  }

  let days = 7;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1]);
      i++;
    }
    if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  try {
    await detectBounces({ days, dryRun });
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
