#!/usr/bin/env npx tsx

/**
 * Campaign Enrichment via Apollo.io
 *
 * Finds executive contacts (CISO, CTO, CEO) for campaign prospects
 * and updates the contact_email and contact_name fields.
 */

import { config } from 'dotenv';
import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();

interface Prospect {
  id: string;
  domain: string;
  company_name: string;
  contact_email: string;
  total_eal_ml: number;
}

async function enrichCampaign(campaignId: string, options: {
  batchSize?: number;
  dryRun?: boolean;
  manualReviewThreshold?: number;
}) {
  const { batchSize = 20, dryRun = false, manualReviewThreshold = 200000 } = options;

  console.log('\n🔍 Campaign Enrichment via Apollo.io\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No database updates\n');
  }

  // 1. Load campaign
  console.log(`📋 Loading campaign: ${campaignId}`);
  const campaignResult = await pool.query(`
    SELECT id, name FROM campaigns WHERE id = $1
  `, [campaignId]);

  if (campaignResult.rows.length === 0) {
    console.error(`❌ Campaign not found: ${campaignId}`);
    process.exit(1);
  }

  const campaign = campaignResult.rows[0];
  console.log(`✅ Campaign: ${campaign.name}\n`);

  // 2. Load prospects needing enrichment
  console.log(`📊 Loading prospects (limit: ${batchSize})...`);
  const prospectsResult = await pool.query<Prospect>(`
    SELECT
      id,
      domain,
      company_name,
      contact_email,
      total_eal_ml
    FROM campaign_prospects
    WHERE campaign_id = $1
      AND status = 'queued'
    ORDER BY total_eal_ml DESC NULLS LAST
    LIMIT $2
  `, [campaignId, batchSize]);

  const prospects = prospectsResult.rows;

  if (prospects.length === 0) {
    console.log('✅ No prospects to enrich.\n');
    return;
  }

  console.log(`📬 Found ${prospects.length} prospects\n`);

  // 3. Separate high-value targets for manual review
  const highValueProspects = prospects.filter(p => p.total_eal_ml >= manualReviewThreshold);
  const autoEnrichProspects = prospects.filter(p => p.total_eal_ml < manualReviewThreshold);

  if (highValueProspects.length > 0) {
    console.log(`⚠️  ${highValueProspects.length} high-value prospects (>= $${manualReviewThreshold.toLocaleString()}) flagged for manual review:`);
    highValueProspects.forEach(p => {
      console.log(`   - ${p.company_name} ($${Math.round(p.total_eal_ml).toLocaleString()})`);
    });
    console.log('');
  }

  if (autoEnrichProspects.length === 0) {
    console.log('ℹ️  All prospects are high-value. Consider manual enrichment.\n');
    return;
  }

  console.log(`🤖 Auto-enriching ${autoEnrichProspects.length} prospects via Apollo...\n`);

  // 4. Initialize Apollo client
  const apolloClient = createApolloClientFromEnv();
  console.log('✅ Apollo client initialized\n');

  // 5. Batch search for executives
  console.log('━'.repeat(80));
  console.log('🔎 Searching for executives...\n');

  const domains = autoEnrichProspects.map(p => p.domain);
  const apolloResults = await apolloClient.batchFindExecutives(domains);

  console.log('\n━'.repeat(80));

  // 6. Update database
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  console.log('\n📝 Updating contacts...\n');

  for (const prospect of autoEnrichProspects) {
    const apolloPerson = apolloResults.get(prospect.domain);

    if (!apolloPerson) {
      console.log(`⚠️  ${prospect.company_name}`);
      console.log(`   No executive found - keeping original: ${prospect.contact_email}`);
      failed++;
      continue;
    }

    const newContactName = apolloPerson.name || `${apolloPerson.first_name} ${apolloPerson.last_name}`.trim();
    const newContactTitle = apolloPerson.title;

    // Prefer work email, fall back to personal email, then original
    const apolloEmail = apolloPerson.email || (apolloPerson.personal_emails && apolloPerson.personal_emails[0]);
    const newContactEmail = apolloEmail || prospect.contact_email;

    console.log(`✅ ${prospect.company_name}`);
    console.log(`   Found: ${newContactName} (${newContactTitle})`);
    if (apolloPerson.email) {
      console.log(`   ✉️  Work email: ${apolloPerson.email}`);
    } else if (apolloPerson.personal_emails && apolloPerson.personal_emails[0]) {
      console.log(`   ✉️  Personal email: ${apolloPerson.personal_emails[0]}`);
    } else {
      console.log(`   ⚠️  No executive email - keeping affected user: ${prospect.contact_email}`);
    }

    if (!dryRun) {
      await pool.query(`
        UPDATE campaign_prospects
        SET
          contact_email = $2,
          contact_name = $3,
          contact_title = $4,
          updated_at = NOW()
        WHERE id = $1
      `, [prospect.id, newContactEmail, newContactName, newContactTitle]);
    }

    enriched++;
    console.log('');
  }

  // 7. Summary
  console.log('━'.repeat(80));
  console.log('\n📊 Enrichment Summary:');
  console.log(`   ✅ Enriched: ${enriched}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⚠️  High-value (manual review): ${highValueProspects.length}`);
  console.log(`   📋 Total: ${prospects.length}\n`);

  if (highValueProspects.length > 0) {
    console.log('⚠️  Next steps for high-value prospects:');
    console.log('   1. Manually search Apollo for these companies');
    console.log('   2. Find CISO/CTO/CEO contact');
    console.log('   3. Update via SQL:\n');
    console.log(`      UPDATE campaign_prospects`);
    console.log(`      SET contact_email = 'exec@example.com',`);
    console.log(`          contact_name = 'Jane Smith',`);
    console.log(`          contact_title = 'CISO'`);
    console.log(`      WHERE id = 'prospect-xxx';\n`);
  }

  if (enriched > 0) {
    console.log('ℹ️  Enrichment uses Apollo People Enrichment API (costs credits).');
    console.log('   Email addresses are revealed when available in Apollo database.\n');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Campaign Enrichment - Find executive contacts via Apollo.io

Usage:
  npm run campaign:enrich -- --campaign-id <ID> [options]

Required:
  --campaign-id <ID>      Campaign ID to enrich

Options:
  --batch-size <number>   Number of prospects to enrich (default: 20)
  --dry-run               Preview without updating database
  --manual-threshold <$>  EAL threshold for manual review (default: 200000)

Environment Variables:
  APOLLO_API_KEY          Your Apollo.io master API key (required)

Examples:
  # Dry run (preview only)
  npm run campaign:enrich -- --campaign-id campaign-123 --dry-run

  # Enrich 10 prospects
  npm run campaign:enrich -- --campaign-id campaign-123 --batch-size 10

  # Custom manual review threshold
  npm run campaign:enrich -- --campaign-id campaign-123 --manual-threshold 150000

Note:
  Apollo's People Search API (api_search) does not return email addresses.
  This script will find executives and update names/titles, but emails
  will remain as the affected users from infostealer data.

  To get executive emails, you need to:
  1. Use Apollo's People Enrichment API (costs credits)
  2. Manually look up executives in Apollo web interface
  3. Use a CSV import workflow
    `);
    process.exit(0);
  }

  let campaignId = '';
  let batchSize = 20;
  let dryRun = false;
  let manualReviewThreshold = 200000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--batch-size':
        batchSize = parseInt(next);
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--manual-threshold':
        manualReviewThreshold = parseFloat(next);
        i++;
        break;
    }
  }

  if (!campaignId) {
    console.error('❌ Error: --campaign-id is required\n');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  try {
    await enrichCampaign(campaignId, { batchSize, dryRun, manualReviewThreshold });
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
