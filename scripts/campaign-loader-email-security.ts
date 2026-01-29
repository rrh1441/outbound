#!/usr/bin/env npx tsx

/**
 * Email Security Campaign Loader
 *
 * Loads prospects from scans with SPF/DKIM/DMARC issues.
 */

import { config } from 'dotenv';
import { randomBytes } from 'crypto';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();

function generateTrackingToken(): string {
  return randomBytes(16).toString('hex');
}

async function loadEmailSecurityProspects(options: {
  campaignId?: string;
  minEal?: number;
  limit?: number;
  dryRun?: boolean;
}) {
  const { minEal = 0, limit = 500, dryRun = false } = options;

  console.log('\n📧 Email Security Campaign Loader\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No database writes\n');
  }

  let campaignId = options.campaignId || 'campaign-email-sec-001';
  const campCheck = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (campCheck.rows.length === 0) {
    console.error(`❌ Campaign ${campaignId} not found.`);
    process.exit(1);
  }
  console.log(`📋 Using campaign: ${campaignId}\n`);

  console.log('🔍 Finding scans with email security issues...');

  const prospectsQuery = await pool.query(`
    WITH email_findings AS (
      SELECT
        f.scan_id,
        f.type,
        f.title,
        f.description,
        f.severity,
        f.eal_ml
      FROM findings f
      WHERE f.type IN (
        'EMAIL_SECURITY_MISCONFIGURATION',
        'EMAIL_SECURITY_GAP',
        'EMAIL_SECURITY_WEAKNESS'
      )
    ),
    scan_summary AS (
      SELECT
        ef.scan_id,
        COUNT(*) as issue_count,
        SUM(ef.eal_ml) as total_email_eal,
        json_agg(json_build_object(
          'type', ef.type,
          'title', ef.title,
          'description', ef.description,
          'severity', ef.severity
        )) as issues,
        -- Check for specific missing records
        bool_or(ef.title ILIKE '%SPF%' OR ef.description ILIKE '%SPF%') as missing_spf,
        bool_or(ef.title ILIKE '%DKIM%' OR ef.description ILIKE '%DKIM%') as missing_dkim,
        bool_or(ef.title ILIKE '%DMARC%' OR ef.description ILIKE '%DMARC%') as missing_dmarc
      FROM email_findings ef
      GROUP BY ef.scan_id
    )
    SELECT
      ss.scan_id,
      s.domain,
      COALESCE(s.metadata->>'company_name', s.domain) as company_name,
      ss.issue_count,
      ss.issues,
      ss.missing_spf,
      ss.missing_dkim,
      ss.missing_dmarc,
      COALESCE(e.total_eal_ml, ss.total_email_eal) as total_eal_ml
    FROM scan_summary ss
    JOIN scans s ON s.id = ss.scan_id
    LEFT JOIN scan_eal_summary e ON e.scan_id = ss.scan_id
    WHERE s.status = 'completed'
      AND COALESCE(e.total_eal_ml, ss.total_email_eal) >= $1
    ORDER BY COALESCE(e.total_eal_ml, ss.total_email_eal) DESC
    LIMIT $2
  `, [minEal, limit]);

  const prospects = prospectsQuery.rows;
  console.log(`📊 Found ${prospects.length} qualifying scans\n`);

  if (prospects.length === 0) {
    console.log('No prospects found matching criteria.');
    return;
  }

  let loaded = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    // Build issue list based on what's missing
    const issueItems: string[] = [];
    if (prospect.missing_spf) issueItems.push('<li><strong>SPF:</strong> No valid SPF record found</li>');
    if (prospect.missing_dkim) issueItems.push('<li><strong>DKIM:</strong> No DKIM signing detected</li>');
    if (prospect.missing_dmarc) issueItems.push('<li><strong>DMARC:</strong> No DMARC policy configured</li>');

    // Add other issues
    prospect.issues.slice(0, 3).forEach((i: any) => {
      if (!issueItems.some(item => item.includes(i.title))) {
        issueItems.push(`<li>${i.title}</li>`);
      }
    });

    const emailSecurityIssues = issueItems.slice(0, 5).join('\n');
    const contactEmail = `security@${prospect.domain}`;

    if (dryRun) {
      console.log(`📧 ${prospect.company_name} (${prospect.domain})`);
      console.log(`   SPF: ${prospect.missing_spf ? '❌' : '✅'} | DKIM: ${prospect.missing_dkim ? '❌' : '✅'} | DMARC: ${prospect.missing_dmarc ? '❌' : '✅'}`);
      console.log(`   EAL: $${Math.round(prospect.total_eal_ml).toLocaleString()}`);
      console.log();
      loaded++;
      continue;
    }

    try {
      await pool.query(`
        INSERT INTO campaign_prospects (
          campaign_id, scan_id, company_name, domain, contact_email,
          total_eal_ml, tracking_token, status, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)
        ON CONFLICT (campaign_id, scan_id) DO UPDATE SET
          total_eal_ml = EXCLUDED.total_eal_ml,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [
        campaignId,
        prospect.scan_id,
        prospect.company_name,
        prospect.domain,
        contactEmail,
        prospect.total_eal_ml,
        generateTrackingToken(),
        JSON.stringify({
          issue_count: prospect.issue_count,
          email_security_issues: emailSecurityIssues,
          missing_spf: prospect.missing_spf,
          missing_dkim: prospect.missing_dkim,
          missing_dmarc: prospect.missing_dmarc,
          issues: prospect.issues.slice(0, 10)
        })
      ]);
      loaded++;
      if (loaded % 10 === 0) process.stdout.write(`\r✨ Loaded ${loaded}...`);
    } catch (error: any) {
      console.error(`\n⚠️  Error: ${error.message}`);
      skipped++;
    }
  }

  console.log(`\n\n✅ Complete! Loaded: ${loaded}, Skipped: ${skipped}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Email Security Campaign Loader

Usage:
  npx tsx scripts/campaign-loader-email-security.ts [options]

Options:
  --min-eal <n>       Minimum EAL threshold (default: 0)
  --limit <n>         Maximum prospects (default: 500)
  --dry-run           Preview without loading
    `);
    process.exit(0);
  }

  let minEal = 0, limit = 500, dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--min-eal': minEal = parseFloat(args[++i]); break;
      case '--limit': limit = parseInt(args[++i]); break;
      case '--dry-run': dryRun = true; break;
    }
  }

  try {
    await loadEmailSecurityProspects({ minEal, limit, dryRun });
  } finally {
    await pool.end();
  }
}

main();
