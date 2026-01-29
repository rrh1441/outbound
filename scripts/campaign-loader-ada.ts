#!/usr/bin/env npx tsx

/**
 * ADA Accessibility Campaign Loader
 *
 * Loads prospects from scans with accessibility issues.
 */

import { config } from 'dotenv';
import { randomBytes } from 'crypto';
import { getPool } from '../lib/database.js';

config();

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

function generateTrackingToken(): string {
  return randomBytes(16).toString('hex');
}

async function loadADAProspects(options: {
  campaignId?: string;
  minIssues?: number;
  minEal?: number;
  limit?: number;
  dryRun?: boolean;
}) {
  const { minIssues = 1, minEal = 0, limit = 500, dryRun = false } = options;

  console.log('\n♿ ADA Accessibility Campaign Loader\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No database writes\n');
  }

  // Get campaign
  let campaignId = options.campaignId || 'campaign-ada-001';
  const campCheck = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (campCheck.rows.length === 0) {
    console.error(`❌ Campaign ${campaignId} not found.`);
    process.exit(1);
  }
  console.log(`📋 Using campaign: ${campaignId}\n`);

  // Find scans with accessibility issues
  console.log('🔍 Finding scans with accessibility issues...');

  const prospectsQuery = await pool.query(`
    WITH ada_findings AS (
      SELECT
        f.scan_id,
        f.title,
        f.description,
        f.severity,
        f.eal_ml
      FROM findings f
      WHERE f.type = 'ACCESSIBILITY_OBSERVATION'
    ),
    scan_summary AS (
      SELECT
        af.scan_id,
        COUNT(*) as issue_count,
        SUM(af.eal_ml) as total_ada_eal,
        json_agg(json_build_object(
          'title', af.title,
          'description', af.description,
          'severity', af.severity
        )) as issues
      FROM ada_findings af
      GROUP BY af.scan_id
      HAVING COUNT(*) >= $1
    )
    SELECT
      ss.scan_id,
      s.domain,
      COALESCE(s.metadata->>'company_name', s.domain) as company_name,
      ss.issue_count,
      ss.issues,
      COALESCE(e.total_eal_ml, ss.total_ada_eal) as total_eal_ml
    FROM scan_summary ss
    JOIN scans s ON s.id = ss.scan_id
    LEFT JOIN scan_eal_summary e ON e.scan_id = ss.scan_id
    WHERE s.status = 'completed'
      AND COALESCE(e.total_eal_ml, ss.total_ada_eal) >= $2
    ORDER BY COALESCE(e.total_eal_ml, ss.total_ada_eal) DESC
    LIMIT $3
  `, [minIssues, minEal, limit]);

  const prospects = prospectsQuery.rows;
  console.log(`📊 Found ${prospects.length} qualifying scans\n`);

  if (prospects.length === 0) {
    console.log('No prospects found matching criteria.');
    return;
  }

  let loaded = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    // Format issues as HTML list
    const accessibilityIssues = prospect.issues
      .slice(0, 5)
      .map((i: any) => `<li>${i.title}</li>`)
      .join('\n');

    const contactEmail = `info@${prospect.domain}`;

    if (dryRun) {
      console.log(`📧 ${prospect.company_name} (${prospect.domain})`);
      console.log(`   Issues: ${prospect.issue_count}`);
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
          accessibility_issues: accessibilityIssues,
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
ADA Accessibility Campaign Loader

Usage:
  npx tsx scripts/campaign-loader-ada.ts [options]

Options:
  --campaign-id <id>  Campaign ID (required)
  --min-issues <n>    Minimum accessibility issues (default: 1)
  --min-eal <n>       Minimum EAL threshold (default: 0)
  --limit <n>         Maximum prospects (default: 500)
  --dry-run           Preview without loading
    `);
    process.exit(0);
  }

  let campaignId = '', minIssues = 1, minEal = 0, limit = 500, dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--campaign-id': campaignId = args[++i]; break;
      case '--min-issues': minIssues = parseInt(args[++i]); break;
      case '--min-eal': minEal = parseFloat(args[++i]); break;
      case '--limit': limit = parseInt(args[++i]); break;
      case '--dry-run': dryRun = true; break;
    }
  }

  if (!campaignId) {
    console.error('❌ --campaign-id is required');
    process.exit(1);
  }

  try {
    await loadADAProspects({ campaignId, minIssues, minEal, limit, dryRun });
  } finally {
    await pool.end();
  }
}

main();
