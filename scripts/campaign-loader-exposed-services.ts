#!/usr/bin/env npx tsx

/**
 * Exposed Services Campaign Loader
 *
 * Loads prospects from scans with exposed databases or admin services.
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

async function loadExposedServicesProspects(options: {
  campaignId?: string;
  minEal?: number;
  limit?: number;
  dryRun?: boolean;
}) {
  const { minEal = 0, limit = 500, dryRun = false } = options;

  console.log('\n🔓 Exposed Services Campaign Loader\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No database writes\n');
  }

  let campaignId = options.campaignId || 'campaign-exposed-db-001';
  const campCheck = await pool.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
  if (campCheck.rows.length === 0) {
    console.error(`❌ Campaign ${campaignId} not found.`);
    process.exit(1);
  }
  console.log(`📋 Using campaign: ${campaignId}\n`);

  console.log('🔍 Finding scans with exposed services...');

  const prospectsQuery = await pool.query(`
    WITH exposed_findings AS (
      SELECT
        f.scan_id,
        f.type,
        f.title,
        f.description,
        f.severity,
        f.eal_ml,
        f.data
      FROM findings f
      WHERE f.type IN (
        'EXPOSED_DATABASE',
        'EXPOSED_CLIENT_DATABASE',
        'EXPOSED_DATABASE_PORT',
        'EXPOSED_SERVICE'
      )
    ),
    scan_summary AS (
      SELECT
        ef.scan_id,
        COUNT(*) as service_count,
        SUM(ef.eal_ml) as total_exposed_eal,
        json_agg(json_build_object(
          'type', ef.type,
          'title', ef.title,
          'description', ef.description,
          'severity', ef.severity,
          'port', ef.data->>'port',
          'service', ef.data->>'service'
        )) as services
      FROM exposed_findings ef
      GROUP BY ef.scan_id
    )
    SELECT
      ss.scan_id,
      s.domain,
      COALESCE(s.metadata->>'company_name', s.domain) as company_name,
      ss.service_count,
      ss.services,
      COALESCE(e.total_eal_ml, ss.total_exposed_eal) as total_eal_ml
    FROM scan_summary ss
    JOIN scans s ON s.id = ss.scan_id
    LEFT JOIN scan_eal_summary e ON e.scan_id = ss.scan_id
    WHERE s.status = 'completed'
      AND COALESCE(e.total_eal_ml, ss.total_exposed_eal) >= $1
    ORDER BY COALESCE(e.total_eal_ml, ss.total_exposed_eal) DESC
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
    // Format services list
    const servicesList = prospect.services
      .slice(0, 5)
      .map((s: any) => {
        const port = s.port ? ` on port ${s.port}` : '';
        const svc = s.service || s.title;
        return `<li><strong>${svc}</strong>${port} - ${s.severity} severity</li>`;
      })
      .join('\n');

    const contactEmail = `security@${prospect.domain}`;

    if (dryRun) {
      console.log(`📧 ${prospect.company_name} (${prospect.domain})`);
      console.log(`   Exposed services: ${prospect.service_count}`);
      console.log(`   EAL: $${Math.round(prospect.total_eal_ml).toLocaleString()}`);
      prospect.services.slice(0, 3).forEach((s: any) => {
        console.log(`   - ${s.service || s.title}${s.port ? ` (port ${s.port})` : ''}`);
      });
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
          service_count: prospect.service_count,
          exposed_services_list: servicesList,
          services: prospect.services.slice(0, 10)
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
Exposed Services Campaign Loader

Usage:
  npx tsx scripts/campaign-loader-exposed-services.ts [options]

Options:
  --campaign-id <id>  Campaign ID (required)
  --min-eal <n>       Minimum EAL threshold (default: 0)
  --limit <n>         Maximum prospects (default: 500)
  --dry-run           Preview without loading
    `);
    process.exit(0);
  }

  let campaignId = '', minEal = 0, limit = 500, dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--campaign-id': campaignId = args[++i]; break;
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
    await loadExposedServicesProspects({ campaignId, minEal, limit, dryRun });
  } finally {
    await pool.end();
  }
}

main();
