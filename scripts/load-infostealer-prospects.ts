#!/usr/bin/env npx tsx

/**
 * Load Infostealer Prospects
 *
 * Creates campaign prospects from enriched campaign_contacts.
 * These contacts have already been:
 * 1. Identified as having infostealer findings
 * 2. Enriched with contact info from Apollo
 * 3. Email verified to remove definite bounces
 */

import { config } from 'dotenv';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../lib/database.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

function generateTrackingToken(): string {
  return randomBytes(16).toString('hex');
}

async function loadInfostealerProspects(options: {
  campaignId?: string;
  limit?: number;
  dryRun?: boolean;
}) {
  const { limit = 500, dryRun = false } = options;

  console.log('\n🔐 Infostealer Campaign Loader\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No database writes\n');
  }

  // Load template
  const templatePath = join(__dirname, '..', 'templates', 'email', 'infostealer-high-impact.hbs');
  let bodyTemplate: string;
  try {
    bodyTemplate = readFileSync(templatePath, 'utf-8');
    console.log('✅ Loaded template from:', templatePath);
  } catch (err) {
    console.error('❌ Could not load template:', templatePath);
    process.exit(1);
  }

  // Create or get campaign
  let campaignId = options.campaignId;

  if (!campaignId) {
    campaignId = 'campaign-infostealer-' + Date.now();

    if (!dryRun) {
      await pool.query(`
        INSERT INTO campaigns (id, name, status, subject_template, body_template, from_name, from_email, created_at)
        VALUES ($1, $2, 'active', $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          body_template = EXCLUDED.body_template
      `, [
        campaignId,
        'Infostealer Campaign - ' + new Date().toISOString().split('T')[0],
        'Security notice: {{company_name}} credentials exposed in malware logs',
        bodyTemplate,
        'Ryan Heger',
        'ryan@simplcyber-report.com'
      ]);
      console.log(`✅ Created campaign: ${campaignId}\n`);
    } else {
      console.log(`📋 Would create campaign: ${campaignId}\n`);
    }
  }

  // Load enriched contacts and their infostealer emails from artifacts
  // Filters out invalid contacts and prioritizes validated ones
  console.log('🔍 Loading enriched infostealer contacts...\n');

  const contactsResult = await pool.query(`
    WITH contact_with_scan AS (
      SELECT
        cc.id as contact_id,
        cc.company_name,
        cc.domain,
        cc.email as contact_email,
        cc.first_name,
        cc.is_catch_all,
        cc.validation_status,
        cc.validation_score,
        s.id as scan_id
      FROM campaign_contacts cc
      JOIN scans s ON REPLACE(s.domain, 'www.', '') = REPLACE(cc.domain, 'www.', '')
      WHERE cc.campaign_type = 'infostealer_credentials'
        AND cc.email IS NOT NULL
        AND s.status = 'completed'
        -- Validation filter: exclude invalid contacts, allow pending/valid/stale
        AND COALESCE(cc.validation_status, 'pending') != 'invalid'
    ),
    infostealer_emails AS (
      SELECT
        cws.contact_id,
        cws.scan_id,
        jsonb_agg(DISTINCT r->>'email') as critical_emails,
        COUNT(DISTINCT r->>'email') as critical_user_count
      FROM contact_with_scan cws
      JOIN artifacts a ON a.scan_id = cws.scan_id AND a.type = 'breach_directory_summary'
      CROSS JOIN LATERAL jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') as r
      WHERE r->'source'->>'name' = 'Stealer Logs'
      GROUP BY cws.contact_id, cws.scan_id
    )
    SELECT
      cws.contact_id,
      cws.company_name,
      cws.domain,
      cws.contact_email,
      cws.first_name,
      cws.is_catch_all,
      cws.validation_status,
      cws.validation_score,
      cws.scan_id,
      COALESCE(ie.critical_emails, '[]'::jsonb) as critical_emails,
      COALESCE(ie.critical_user_count, 0) as critical_user_count,
      COALESCE(e.total_eal_ml, 0) as total_eal_ml
    FROM contact_with_scan cws
    LEFT JOIN infostealer_emails ie ON ie.contact_id = cws.contact_id
    LEFT JOIN scan_eal_summary e ON e.scan_id = cws.scan_id
    WHERE COALESCE(ie.critical_user_count, 0) > 0
    ORDER BY
      -- Prioritize validated contacts: valid > pending > stale
      CASE cws.validation_status
        WHEN 'valid' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'stale' THEN 2
        ELSE 3
      END,
      -- Then by validation score (higher = better)
      cws.validation_score DESC NULLS LAST,
      -- Then by critical user count
      ie.critical_user_count DESC,
      -- Finally by EAL
      e.total_eal_ml DESC NULLS LAST
    LIMIT $1
  `, [limit]);

  const contacts = contactsResult.rows;
  console.log(`📬 Found ${contacts.length} enriched contacts with infostealer data\n`);

  if (contacts.length === 0) {
    console.log('No contacts found.');
    return;
  }

  // Show sample with validation status
  console.log('Sample contacts:');
  for (const c of contacts.slice(0, 5)) {
    const validationInfo = c.validation_status
      ? `[${c.validation_status}:${c.validation_score || '?'}]`
      : '[pending]';
    console.log(`  - ${c.company_name} (${c.contact_email}) ${validationInfo}: ${c.critical_user_count} exposed accounts`);
  }
  console.log('');

  // Check for existing prospects
  const existingResult = await pool.query(`
    SELECT contact_email FROM campaign_prospects
    WHERE campaign_id = $1
  `, [campaignId]);
  const existingEmails = new Set(existingResult.rows.map(r => r.contact_email.toLowerCase()));

  let created = 0;
  let skipped = 0;

  for (const contact of contacts) {
    if (existingEmails.has(contact.contact_email.toLowerCase())) {
      skipped++;
      continue;
    }

    const trackingToken = generateTrackingToken();

    // Parse email arrays
    const criticalEmails = typeof contact.critical_emails === 'string'
      ? JSON.parse(contact.critical_emails)
      : contact.critical_emails;

    if (!dryRun) {
      await pool.query(`
        INSERT INTO campaign_prospects (
          id,
          campaign_id,
          scan_id,
          company_name,
          domain,
          contact_email,
          contact_name,
          critical_user_count,
          medium_user_count,
          critical_user_emails,
          medium_user_emails,
          total_eal_ml,
          tracking_token,
          status,
          is_catch_all,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'queued', $14, NOW(), NOW())
        ON CONFLICT (campaign_id, scan_id) DO NOTHING
      `, [
        `prospect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        campaignId,
        contact.scan_id,
        contact.company_name,
        contact.domain,
        contact.contact_email,
        contact.first_name,
        contact.critical_user_count,
        0, // medium_user_count - not used for infostealer campaign
        criticalEmails,
        [], // medium_user_emails - not used for infostealer campaign
        contact.total_eal_ml || 0,
        trackingToken,
        contact.is_catch_all || false
      ]);
    }

    created++;
  }

  console.log('━'.repeat(60));
  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Created: ${created} prospects`);
  console.log(`   ⏭️  Skipped (existing): ${skipped}`);
  console.log(`   📋 Campaign ID: ${campaignId}\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - No changes made\n');
  } else {
    console.log(`\n🚀 To send test emails:\n`);
    console.log(`   CAMPAIGN_TEST_MODE=true npm run campaign:schedule -- --campaign-id ${campaignId} --dry-run\n`);
  }

  return campaignId;
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Infostealer Campaign Loader

Usage:
  npx tsx scripts/load-infostealer-prospects.ts [options]

Options:
  --campaign-id <ID>   Use existing campaign (default: create new)
  --limit <n>          Max prospects to load (default: 500)
  --dry-run            Preview without database writes

Examples:
  # Dry run
  npx tsx scripts/load-infostealer-prospects.ts --dry-run

  # Load up to 150 prospects
  npx tsx scripts/load-infostealer-prospects.ts --limit 150
    `);
    process.exit(0);
  }

  let campaignId: string | undefined;
  let limit = 500;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--limit':
        limit = parseInt(next);
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  try {
    await loadInfostealerProspects({ campaignId, limit, dryRun });
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
