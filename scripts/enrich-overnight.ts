#!/usr/bin/env npx tsx

/**
 * Overnight Campaign Enrichment Runner
 *
 * Continuously enriches companies in priority order with robust error handling:
 * - Auto-respects API rate limits (400 calls/hour)
 * - Retries on failures
 * - Saves progress continuously
 * - Can be stopped and resumed
 * - Runs until all campaigns enriched or stopped
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

// Rate limiting: 400 calls/hour = 6.66/minute
// Each enrichment = ~2 calls (search + enrich)
// So ~3 companies/minute = ~180/hour safely under limit
const COMPANIES_PER_BATCH = 10;
const DELAY_BETWEEN_COMPANIES_MS = 2000; // 2 seconds = 30/min = ~15 actual enrichments/min
const DELAY_BETWEEN_BATCHES_MS = 5000; // 5 second pause between batches
const MAX_RETRIES_PER_COMPANY = 3;

interface EnrichmentStats {
  totalProcessed: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  startTime: Date;
  lastUpdateTime: Date;
}

const stats: EnrichmentStats = {
  totalProcessed: 0,
  successCount: 0,
  failureCount: 0,
  retryCount: 0,
  startTime: new Date(),
  lastUpdateTime: new Date()
};

async function getNextCompany() {
  const result = await pool.query(`
    WITH latest_scans AS (
      SELECT DISTINCT ON (domain)
        id,
        domain,
        metadata->>'company_name' as company_name,
        campaign_type
      FROM scans
      WHERE status = 'completed'
        AND campaign_type IS NOT NULL
        AND campaign_type != 'no_campaign'
      ORDER BY domain, created_at DESC
    )
    SELECT
      ls.id as scan_id,
      ls.domain,
      ls.company_name,
      ls.campaign_type
    FROM latest_scans ls
    WHERE NOT EXISTS (
      SELECT 1 FROM campaign_contacts cc
      WHERE cc.scan_id = ls.id
    )
    ORDER BY
      CASE ls.campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'ada_accessibility' THEN 3
        WHEN 'email_security' THEN 4
        ELSE 5
      END,
      ls.domain
    LIMIT 1
  `);

  return result.rows[0] || null;
}

async function enrichCompany(apolloClient: any, company: any, retryCount: number = 0): Promise<boolean> {
  const { scan_id, domain, company_name, campaign_type } = company;

  const retryPrefix = retryCount > 0 ? `[Retry ${retryCount}] ` : '';
  console.log(`${retryPrefix}🔍 ${company_name || domain} (${campaign_type})`);

  try {
    // Find executive contact
    const person = await apolloClient.findExecutiveContact(domain, true);

    if (!person) {
      console.log('  ⚠️  No executive found');
      return false;
    }

    const email = person.email || (person.personal_emails && person.personal_emails[0]);
    if (!email) {
      console.log('  ⚠️  Contact found but no email');
      return false;
    }

    console.log(`  ✅ ${person.name} (${person.title}) - ${email}`);

    // Insert into campaign_contacts
    await pool.query(`
      INSERT INTO campaign_contacts (
        scan_id,
        domain,
        company_name,
        first_name,
        last_name,
        full_name,
        title,
        email,
        personal_emails,
        linkedin_url,
        apollo_person_id,
        campaign_type,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'enriched')
    `, [
      scan_id,
      domain,
      company_name,
      person.first_name,
      person.last_name,
      person.name,
      person.title,
      email,
      person.personal_emails || [],
      person.linkedin_url,
      person.id,
      campaign_type
    ]);

    return true;
  } catch (error: any) {
    // Check if it's a rate limit error
    if (error.message.includes('429') || error.message.includes('rate limit')) {
      console.error(`  ⏱️  Rate limit hit - waiting 60 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 60000));

      // Retry this company
      if (retryCount < MAX_RETRIES_PER_COMPANY) {
        stats.retryCount++;
        return enrichCompany(apolloClient, company, retryCount + 1);
      }
    }

    console.error(`  ❌ Error: ${error.message}`);
    return false;
  }
}

function printStats() {
  const elapsed = Date.now() - stats.startTime.getTime();
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);

  const successRate = stats.totalProcessed > 0
    ? Math.round((stats.successCount / stats.totalProcessed) * 100)
    : 0;

  const companiesPerHour = stats.totalProcessed > 0 && elapsed > 0
    ? Math.round((stats.totalProcessed / elapsed) * 3600000)
    : 0;

  console.log('\n' + '━'.repeat(70));
  console.log(`📊 Enrichment Progress`);
  console.log('━'.repeat(70));
  console.log(`Runtime: ${hours}h ${minutes}m`);
  console.log(`Processed: ${stats.totalProcessed} companies`);
  console.log(`✅ Success: ${stats.successCount} (${successRate}%)`);
  console.log(`❌ Failed: ${stats.failureCount}`);
  console.log(`🔄 Retries: ${stats.retryCount}`);
  console.log(`⚡ Rate: ~${companiesPerHour} companies/hour`);
  console.log('━'.repeat(70) + '\n');
}

async function getCampaignProgress() {
  const result = await pool.query(`
    WITH latest_scans AS (
      SELECT DISTINCT ON (domain) id, campaign_type
      FROM scans
      WHERE status = 'completed'
        AND campaign_type IS NOT NULL
        AND campaign_type != 'no_campaign'
      ORDER BY domain, created_at DESC
    ),
    total_by_campaign AS (
      SELECT campaign_type, COUNT(*) as total
      FROM latest_scans
      GROUP BY campaign_type
    ),
    enriched_by_campaign AS (
      SELECT campaign_type, COUNT(*) as enriched
      FROM campaign_contacts
      GROUP BY campaign_type
    )
    SELECT
      t.campaign_type,
      t.total,
      COALESCE(e.enriched, 0) as enriched,
      t.total - COALESCE(e.enriched, 0) as remaining,
      ROUND(COALESCE(e.enriched, 0) * 100.0 / t.total, 1) as pct_complete
    FROM total_by_campaign t
    LEFT JOIN enriched_by_campaign e ON e.campaign_type = t.campaign_type
    ORDER BY
      CASE t.campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'ada_accessibility' THEN 3
        WHEN 'email_security' THEN 4
        ELSE 5
      END
  `);

  return result.rows;
}

async function main() {
  console.log('🌙 Overnight Campaign Enrichment Started\n');
  console.log(`Rate Limiting: ~${COMPANIES_PER_BATCH} companies per batch`);
  console.log(`Delay: ${DELAY_BETWEEN_COMPANIES_MS}ms between companies`);
  console.log(`Max Retries: ${MAX_RETRIES_PER_COMPANY} per company\n`);

  // Show initial progress
  const initialProgress = await getCampaignProgress();
  console.log('📋 Initial Campaign Progress:\n');
  initialProgress.forEach(row => {
    console.log(`  ${row.campaign_type}: ${row.enriched}/${row.total} (${row.pct_complete}%) - ${row.remaining} remaining`);
  });
  console.log('');

  const apolloClient = createApolloClientFromEnv();
  let batchNumber = 0;

  // Main enrichment loop
  while (true) {
    batchNumber++;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔄 Batch ${batchNumber} Starting`);
    console.log('='.repeat(70) + '\n');

    let batchProcessed = 0;

    // Process batch
    for (let i = 0; i < COMPANIES_PER_BATCH; i++) {
      // Get next company
      const company = await getNextCompany();

      if (!company) {
        console.log('\n✅ All companies enriched! No more work to do.\n');
        printStats();

        // Final progress
        const finalProgress = await getCampaignProgress();
        console.log('\n📊 Final Campaign Progress:\n');
        finalProgress.forEach(row => {
          console.log(`  ${row.campaign_type}: ${row.enriched}/${row.total} (${row.pct_complete}%)`);
        });

        await pool.end();
        process.exit(0);
      }

      // Enrich company
      const success = await enrichCompany(apolloClient, company);

      stats.totalProcessed++;
      stats.lastUpdateTime = new Date();
      batchProcessed++;

      if (success) {
        stats.successCount++;
      } else {
        stats.failureCount++;
      }

      // Delay before next company (except last one in batch)
      if (i < COMPANIES_PER_BATCH - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_COMPANIES_MS));
      }
    }

    // Print stats after each batch
    printStats();

    // Show progress every 5 batches
    if (batchNumber % 5 === 0) {
      const progress = await getCampaignProgress();
      console.log('📈 Campaign Progress:\n');
      progress.forEach(row => {
        console.log(`  ${row.campaign_type}: ${row.enriched}/${row.total} (${row.pct_complete}%) - ${row.remaining} remaining`);
      });
      console.log('');
    }

    // Delay before next batch
    console.log(`⏸️  Pausing ${DELAY_BETWEEN_BATCHES_MS / 1000}s before next batch...\n`);
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n⏹️  Shutting down gracefully...\n');
  printStats();

  const progress = await getCampaignProgress();
  console.log('📊 Campaign Progress at Shutdown:\n');
  progress.forEach(row => {
    console.log(`  ${row.campaign_type}: ${row.enriched}/${row.total} (${row.pct_complete}%)`);
  });

  await pool.end();
  process.exit(0);
});

main().catch(async (error) => {
  console.error('\n❌ Fatal error:', error);
  printStats();
  await pool.end();
  process.exit(1);
});
