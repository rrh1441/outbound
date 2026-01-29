#!/usr/bin/env npx tsx

/**
 * Daily Campaign Check
 *
 * Quick stats on campaign performance:
 * - Emails sent today
 * - New replies (real vs spam)
 * - New bounces
 * - Running totals
 *
 * Usage:
 *   npm run campaign:daily-check
 *   npx tsx scripts/daily-campaign-check.ts
 */

import * as dotenv from 'dotenv';
import { getPool } from '../lib/database.js';

dotenv.config();

const pool = getPool();

async function dailyCheck() {
  console.log('\n📊 DAILY CAMPAIGN CHECK');
  console.log('═'.repeat(50));
  console.log(`Date: ${new Date().toLocaleDateString()}\n`);

  // 1. Today's sends
  const today = await pool.query(`
    SELECT COUNT(*) as count
    FROM campaign_emails
    WHERE direction = 'outbound'
    AND sent_at::date = CURRENT_DATE
  `);
  console.log(`📤 SENT TODAY: ${today.rows[0].count}`);

  // 2. Sends by day (last 7 days)
  const byDay = await pool.query(`
    SELECT
      sent_at::date as day,
      COUNT(*) as count
    FROM campaign_emails
    WHERE direction = 'outbound'
    AND sent_at > NOW() - INTERVAL '7 days'
    GROUP BY sent_at::date
    ORDER BY day DESC
  `);
  console.log('\n📅 LAST 7 DAYS:');
  byDay.rows.forEach(r => {
    const day = new Date(r.day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    console.log(`   ${day}: ${r.count}`);
  });

  // 3. Total sent all time
  const totalSent = await pool.query(`
    SELECT COUNT(*) as count, MIN(sent_at) as first_sent
    FROM campaign_emails
    WHERE direction = 'outbound'
  `);
  const firstSent = new Date(totalSent.rows[0].first_sent).toLocaleDateString();
  console.log(`\n📨 TOTAL SENT: ${totalSent.rows[0].count} (since ${firstSent})`);

  // 4. Real replies (exclude warmup spam)
  const replies = await pool.query(`
    SELECT from_email, subject, snippet, received_at
    FROM inbox_messages
    WHERE direction = 'inbound'
    AND subject ILIKE 'Re:%'
    AND subject NOT LIKE '%N284PY4%'
    AND from_email NOT LIKE '%.info'
    AND from_email NOT LIKE '%.online'
    AND from_email NOT LIKE '%.pro'
    AND from_email NOT LIKE '%mailer-daemon%'
    AND from_email NOT LIKE '%postmaster%'
    AND from_email != 'ryanrheger@gmail.com'
    ORDER BY received_at DESC
  `);

  // Categorize replies
  const positive: any[] = [];
  const neutral: any[] = [];
  const unsub: any[] = [];

  replies.rows.forEach(r => {
    const snippet = (r.snippet || '').toLowerCase();
    if (snippet.includes('remove') || snippet.includes('unsubscribe') || snippet.includes('stop') || snippet.includes('mailing list')) {
      unsub.push(r);
    } else if (snippet.includes('thank') || snippet.includes('patch') || snippet.includes('fix') || snippet.includes('address') || snippet.includes('will look')) {
      positive.push(r);
    } else {
      neutral.push(r);
    }
  });

  console.log(`\n💬 REPLIES: ${replies.rows.length} total`);
  console.log(`   ✅ Positive: ${positive.length}`);
  console.log(`   ⚪ Neutral: ${neutral.length}`);
  console.log(`   🔴 Unsubscribe: ${unsub.length}`);

  // Show new replies (last 24h)
  const newReplies = replies.rows.filter(r => {
    const received = new Date(r.received_at);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return received > dayAgo;
  });

  if (newReplies.length > 0) {
    console.log('\n   🆕 NEW (last 24h):');
    newReplies.forEach(r => {
      console.log(`      ${r.from_email}`);
      console.log(`      "${(r.snippet || '').substring(0, 60)}..."`);
    });
  }

  // 5. Bounces
  const bounces = await pool.query(`
    SELECT COUNT(*) as count
    FROM inbox_messages
    WHERE direction = 'inbound'
    AND (from_email ILIKE '%mailer-daemon%' OR from_email ILIKE '%postmaster%')
  `);
  console.log(`\n❌ BOUNCES: ${bounces.rows[0].count}`);

  // New bounces today
  const newBounces = await pool.query(`
    SELECT snippet
    FROM inbox_messages
    WHERE direction = 'inbound'
    AND (from_email ILIKE '%mailer-daemon%' OR from_email ILIKE '%postmaster%')
    AND received_at::date = CURRENT_DATE
  `);
  if (newBounces.rows.length > 0) {
    console.log(`   🆕 New today: ${newBounces.rows.length}`);
  }

  // 6. Rates
  const total = parseInt(totalSent.rows[0].count);
  const replyRate = total > 0 ? (100 * replies.rows.length / total).toFixed(2) : '0.00';
  const bounceRate = total > 0 ? (100 * parseInt(bounces.rows[0].count) / total).toFixed(2) : '0.00';

  console.log('\n📈 RATES:');
  console.log(`   Reply rate: ${replyRate}%`);
  console.log(`   Bounce rate: ${bounceRate}%`);

  // 7. Warmup spam (info only)
  const warmupSpam = await pool.query(`
    SELECT COUNT(*) as count
    FROM inbox_messages
    WHERE is_read = false
    AND (subject LIKE '%N284PY4%' OR from_email LIKE '%.info' OR from_email LIKE '%.online')
  `);
  if (parseInt(warmupSpam.rows[0].count) > 0) {
    console.log(`\n⚠️  Unread warmup spam: ${warmupSpam.rows[0].count}`);
  }

  // 8. Queue status
  const queue = await pool.query(`
    SELECT COUNT(*) as count FROM campaign_prospects WHERE status = 'queued'
  `);
  const enriched = await pool.query(`
    SELECT COUNT(*) as count FROM campaign_contacts WHERE status = 'enriched'
  `);
  console.log(`\n👥 QUEUE: ${queue.rows[0].count} queued (${enriched.rows[0].count} enriched contacts available)`);

  console.log('\n' + '═'.repeat(50));

  await pool.end();
}

dailyCheck().catch(console.error);
