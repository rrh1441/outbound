#!/usr/bin/env npx tsx

/**
 * Query which inbox sent to which prospect
 *
 * Useful for:
 * - Finding which inbox to reply from
 * - Auditing send distribution
 * - Debugging delivery issues
 *
 * Usage:
 *   npm run campaign:sender-report -- --campaign-id <ID>
 *   npm run campaign:sender-report -- --domain example.com
 *   npm run campaign:sender-report -- --sender inbox1@example.com
 */

import { config } from 'dotenv';
import { getPool, isSupabase } from '../lib/database.js';

config();

const pool = getPool();

interface ReportRow {
  company_name: string;
  domain: string;
  contact_email: string;
  sender_email: string | null;
  status: string;
  last_sent_at: Date | null;
  sender_name: string | null;
}

async function showSenderReport(filters: {
  campaignId?: string;
  domain?: string;
  sender?: string;
  status?: string;
  limit?: number;
}): Promise<void> {
  let whereClause = '1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.campaignId) {
    whereClause += ` AND p.campaign_id = $${paramIndex++}`;
    params.push(filters.campaignId);
  }
  if (filters.domain) {
    whereClause += ` AND p.domain ILIKE $${paramIndex++}`;
    params.push(`%${filters.domain}%`);
  }
  if (filters.sender) {
    whereClause += ` AND p.sender_email = $${paramIndex++}`;
    params.push(filters.sender);
  }
  if (filters.status) {
    whereClause += ` AND p.status = $${paramIndex++}`;
    params.push(filters.status);
  }

  const limit = filters.limit || 100;

  const result = await pool.query<ReportRow>(`
    SELECT
      p.company_name,
      p.domain,
      p.contact_email,
      p.sender_email,
      p.status,
      p.last_sent_at,
      s.display_name as sender_name
    FROM campaign_prospects p
    LEFT JOIN sender_accounts s ON s.email = p.sender_email
    WHERE ${whereClause}
    ORDER BY p.last_sent_at DESC NULLS LAST
    LIMIT ${limit}
  `, params);

  console.log('\n📊 Sender Report\n');
  console.log(`Database: ${isSupabase() ? 'Supabase (production)' : 'Local'}`);
  console.log('');
  console.log('━'.repeat(140));
  console.log(
    'COMPANY'.padEnd(25) +
    'DOMAIN'.padEnd(25) +
    'CONTACT'.padEnd(30) +
    'SENDER'.padEnd(35) +
    'STATUS'.padEnd(12) +
    'SENT'
  );
  console.log('━'.repeat(140));

  for (const row of result.rows) {
    const sentAt = row.last_sent_at
      ? new Date(row.last_sent_at).toLocaleDateString()
      : '-';
    console.log(
      (row.company_name || '-').substring(0, 24).padEnd(25) +
      (row.domain || '-').substring(0, 24).padEnd(25) +
      (row.contact_email || '-').substring(0, 29).padEnd(30) +
      (row.sender_email || '(not assigned)').substring(0, 34).padEnd(35) +
      (row.status || '-').padEnd(12) +
      sentAt
    );
  }

  console.log('━'.repeat(140));
  console.log(`\nShowing ${result.rows.length} records (limit: ${limit})\n`);

  // Show summary by sender
  if (!filters.sender) {
    const summaryResult = await pool.query(`
      SELECT
        COALESCE(p.sender_email, '(unassigned)') as sender,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE p.status = 'sent') as sent,
        COUNT(*) FILTER (WHERE p.status = 'queued') as queued
      FROM campaign_prospects p
      WHERE ${whereClause}
      GROUP BY COALESCE(p.sender_email, '(unassigned)')
      ORDER BY sender
    `, params);

    if (summaryResult.rows.length > 0) {
      console.log('📧 Summary by sender:');
      for (const row of summaryResult.rows) {
        console.log(`   ${row.sender}: ${row.total} total (${row.sent} sent, ${row.queued} queued)`);
      }
      console.log('');
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
📊 Sender Report

Query which inbox sent (or will send) to which prospect.

Usage:
  npm run campaign:sender-report -- [options]

Options:
  --campaign-id <ID>     Filter by campaign
  --domain <domain>      Filter by domain (partial match)
  --sender <email>       Filter by sender email
  --status <status>      Filter by status (queued, sent, etc.)
  --limit <n>            Max records to show (default: 100)

Examples:
  # All prospects for a campaign
  npm run campaign:sender-report -- --campaign-id campaign-123

  # Find who sent to a specific domain
  npm run campaign:sender-report -- --domain example.com

  # See all prospects assigned to a specific inbox
  npm run campaign:sender-report -- --sender ryan@simplcyber.io

  # See queued prospects with their assignments
  npm run campaign:sender-report -- --campaign-id campaign-123 --status queued
    `);
    process.exit(0);
  }

  let campaignId: string | undefined;
  let domain: string | undefined;
  let sender: string | undefined;
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--domain':
        domain = next;
        i++;
        break;
      case '--sender':
        sender = next;
        i++;
        break;
      case '--status':
        status = next;
        i++;
        break;
      case '--limit':
        limit = parseInt(next);
        i++;
        break;
    }
  }

  if (!campaignId && !domain && !sender) {
    console.log('Tip: Use --campaign-id, --domain, or --sender to filter results');
    console.log('     Use --help for more options\n');
  }

  try {
    await showSenderReport({ campaignId, domain, sender, status, limit });
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
