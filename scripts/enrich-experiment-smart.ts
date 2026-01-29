#!/usr/bin/env npx tsx

/**
 * Smart Enrichment for Discovery Experiments
 *
 * Optimizations:
 * - Checks Apollo search cache (30-day TTL)
 * - Routes by vertical: Software/Accounting → Apollo, Plumbing → Harvest
 * - Tracks daily Apollo quota (2000 searches/day limit)
 * - Waterfall: Apollo → Harvest (no fake role emails)
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { createHarvestClientFromEnv } from '../apps/campaigns/core/harvest-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

const DELAY_MS = 10000; // 10 seconds = ~360 requests/hour (respects 400/hr limit)
const APOLLO_DAILY_LIMIT = 1900; // Leave 100 buffer from 2000 limit
const APOLLO_HOURLY_LIMIT = 400; // Apollo's fixed hourly rate limit

// Vertical routing
const USE_APOLLO_FOR_VERTICAL = {
  software: true,      // 90%+ Apollo hit rate
  accounting: true,    // 60-70% Apollo hit rate
  plumbing: false      // 10-25% Apollo hit rate → use Harvest
};

async function getApolloSearchesToday(): Promise<number> {
  const result = await pool.query(`
    SELECT COUNT(*) as count
    FROM apollo_search_cache
    WHERE searched_at::date = CURRENT_DATE
  `);
  return parseInt(result.rows[0].count);
}

async function getCachedResult(domain: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT result FROM apollo_search_cache
    WHERE domain = $1 AND searched_at > NOW() - INTERVAL '30 days'
  `, [domain]);
  return result.rows[0]?.result || null;
}

async function cacheApolloResult(domain: string, result: 'found' | 'not_found'): Promise<void> {
  await pool.query(`
    INSERT INTO apollo_search_cache (domain, result, searched_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (domain) DO UPDATE SET
      result = EXCLUDED.result,
      updated_at = NOW()
  `, [domain, result]);
}

/**
 * Determine campaign_type based on scan findings.
 */
async function determineCampaignType(scanId: string): Promise<string> {
  const result = await pool.query(`SELECT type FROM findings WHERE scan_id = $1`, [scanId]);
  const findingTypes = new Set(result.rows.map(r => r.type));

  if (findingTypes.has('CRITICAL_BREACH_EXPOSURE')) return 'infostealer_credentials';
  if (findingTypes.has('WP_PLUGIN_VULNERABILITY')) return 'wordpress';
  if (findingTypes.has('NEXTJS_RSC_RCE_EXPOSURE')) return 'nextjs_rsc';
  if (findingTypes.has('ACCESSIBILITY_OBSERVATION') || findingTypes.has('ADA_RISK_BAND')) return 'ada_accessibility';
  if (findingTypes.has('EMAIL_SECURITY_GAP') || findingTypes.has('EMAIL_SECURITY_WEAKNESS') || findingTypes.has('EMAIL_SECURITY_MISCONFIGURATION')) return 'email_security';
  return 'email_security';
}

async function getScansBatch(experimentBatch: string, limit: number): Promise<any[]> {
  const result = await pool.query(`
    SELECT
      s.id as scan_id,
      s.domain,
      s.metadata->>'company_name' as company_name,
      ls.query_template,
      ls.query_params->>'vertical' as vertical
    FROM scans s
    JOIN lead_sources ls ON ls.scan_id = s.id
    WHERE ls.experiment_batch = $1
      AND s.status = 'completed'
      AND ls.campaign_status != 'disqualified'
      AND s.domain NOT IN (SELECT domain FROM campaign_contacts WHERE domain IS NOT NULL)
    ORDER BY s.created_at DESC
    LIMIT $2
  `, [experimentBatch, limit]);

  return result.rows;
}

async function enrichCompany(company: any, index: number, total: number, apolloClient: any, harvestClient: any, apolloQuotaRemaining: number) {
  console.log(`\n[${index}/${total}] ${'━'.repeat(50)}`);
  console.log(`🔍 ${company.company_name || company.domain}`);
  console.log(`   Vertical: ${company.vertical}`);
  console.log(`   Domain: ${company.domain}`);

  // Determine campaign_type based on findings BEFORE enrichment
  const campaignType = await determineCampaignType(company.scan_id);
  console.log(`   🏷️  Campaign type: ${campaignType}`);

  const useApollo = USE_APOLLO_FOR_VERTICAL[company.vertical as keyof typeof USE_APOLLO_FOR_VERTICAL] !== false;

  try {
    // 1. Try Apollo (if vertical matches and quota available)
    if (useApollo && apolloQuotaRemaining > 0) {
      const cached = await getCachedResult(company.domain);

      if (cached === 'not_found') {
        console.log(`   💾 Apollo cache: previously not found (skipping)`);
      } else {
        console.log(`   🔄 Trying Apollo (${apolloQuotaRemaining} quota remaining)...`);
        const contact = await apolloClient.findExecutiveContact(company.domain);

        // Cache result
        await cacheApolloResult(company.domain, contact ? 'found' : 'not_found');

        if (contact && contact.email) {
          console.log(`   ✅ Apollo: ${contact.name} (${contact.title})`);
          console.log(`      Email: ${contact.email}`);
          console.log(`   💾 Saving to database...`);

          await pool.query(`
            INSERT INTO campaign_contacts (
              id, scan_id, domain, company_name, first_name, last_name,
              full_name, title, email, personal_emails, linkedin_url,
              apollo_person_id, campaign_type, status, enrichment_source
            ) VALUES (
              'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'enriched', 'apollo'
            )
          `, [
            company.scan_id, company.domain, company.company_name,
            contact.firstName, contact.lastName, contact.name,
            contact.title, contact.email, contact.personalEmails || [],
            contact.linkedinUrl, contact.id, campaignType
          ]);

          console.log(`   ✅ Saved (source: apollo)`);
          return { success: true, source: 'apollo', quotaUsed: 1 };
        }

        console.log(`   ⚠️  Apollo: No executive found`);
      }
    } else if (!useApollo) {
      console.log(`   ⏭️  Skipping Apollo (vertical: ${company.vertical} → Harvest preferred)`);
    } else {
      console.log(`   ⏭️  Skipping Apollo (daily quota exhausted)`);
    }

    // 2. Try Harvest
    if (harvestClient) {
      console.log(`   🔄 Trying Harvest...`);
      const executives = await harvestClient.findExecutivesAtCompany(company.domain);

      if (executives.length > 0) {
        const exec = executives[0];
        console.log(`   ✅ Harvest: ${exec.name} (${exec.title})`);
        console.log(`      Email: ${exec.email}`);
        console.log(`   💾 Saving to database...`);

        const nameParts = exec.name.split(' ');
        const firstName = nameParts[0] || null;
        const lastName = nameParts.slice(1).join(' ') || null;

        await pool.query(`
          INSERT INTO campaign_contacts (
            id, scan_id, domain, company_name, first_name, last_name,
            full_name, title, email, personal_emails, linkedin_url,
            apollo_person_id, campaign_type, status, enrichment_source
          ) VALUES (
            'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
            $1, $2, $3, $4, $5, $6, $7, $8, '{}', $9, NULL, $10, 'enriched', 'harvest'
          )
        `, [
          company.scan_id, company.domain, company.company_name,
          firstName, lastName, exec.name, exec.title,
          exec.email, exec.linkedinUrl, campaignType
        ]);

        console.log(`   ✅ Saved (source: harvest)`);
        return { success: true, source: 'harvest', quotaUsed: 0 };
      }

      console.log(`   ⚠️  Harvest: No executives found`);
    }

    console.log(`   ⚠️  No contact found via any method`);
    return { success: false, reason: 'no_contact', quotaUsed: 0 };

  } catch (error: any) {
    if (error.message?.includes('429') || error.message?.includes('rate limit')) {
      console.log(`   ❌ RATE LIMIT HIT: ${error.message}`);
      return { success: false, reason: 'rate_limit', fatal: true, quotaUsed: 0 };
    }
    console.log(`   ❌ Error: ${error.message}`);
    return { success: false, reason: 'error', quotaUsed: 0 };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const batchArg = args.find(a => a.startsWith('--batch='));
  const limitArg = args.find(a => a.startsWith('--limit='));

  if (!batchArg) {
    console.error('Usage: npm run experiment:enrich:smart -- --batch=exp_20251123_paginated [--limit=100]');
    process.exit(1);
  }

  const experimentBatch = batchArg.split('=')[1];
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 500;

  console.log('🚀 Smart Discovery Experiment Enrichment');
  console.log(`   Batch: ${experimentBatch}`);
  console.log(`   Limit: ${limit} scans\n`);

  // Check Apollo quota
  const apolloUsedToday = await getApolloSearchesToday();
  const apolloRemaining = Math.max(0, APOLLO_DAILY_LIMIT - apolloUsedToday);

  console.log(`📊 Apollo quota: ${apolloUsedToday}/${APOLLO_DAILY_LIMIT} used today (${apolloRemaining} remaining)\n`);

  if (apolloRemaining === 0) {
    console.log('⚠️  Apollo quota exhausted for today. Will use Harvest only.\n');
  }

  const scans = await getScansBatch(experimentBatch, limit);

  if (scans.length === 0) {
    console.log('✅ No scans need enrichment');
    await pool.end();
    process.exit(0);
  }

  console.log(`Found ${scans.length} scans to enrich\n`);

  // Count by vertical
  const verticalCounts = scans.reduce((acc: any, s) => {
    acc[s.vertical] = (acc[s.vertical] || 0) + 1;
    return acc;
  }, {});
  console.log(`Verticals: ${Object.entries(verticalCounts).map(([k,v]) => `${k}=${v}`).join(', ')}\n`);

  const apolloClient = createApolloClientFromEnv();
  const harvestClient = createHarvestClientFromEnv();

  let succeeded = 0;
  let noContact = 0;
  let errors = 0;
  let apolloQuotaUsed = 0;
  let sourceCounts = { apollo: 0, harvest: 0 };

  for (let i = 0; i < scans.length; i++) {
    const quotaLeft = apolloRemaining - apolloQuotaUsed;
    const result = await enrichCompany(scans[i], i + 1, scans.length, apolloClient, harvestClient, quotaLeft);

    if (result.fatal) {
      console.log('\n❌ Fatal error - stopping');
      break;
    }

    apolloQuotaUsed += result.quotaUsed || 0;

    if (result.success) {
      succeeded++;
      sourceCounts[result.source as keyof typeof sourceCounts]++;
    } else if (result.reason === 'no_contact') {
      noContact++;
    } else {
      errors++;
    }

    if (i < scans.length - 1) {
      console.log(`   ⏸️  Waiting ${DELAY_MS/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Enrichment Results`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total processed: ${scans.length}`);
  console.log(`✅ Success: ${succeeded} (${Math.round(succeeded/scans.length*100)}%)`);
  console.log(`   - Apollo: ${sourceCounts.apollo}`);
  console.log(`   - Harvest: ${sourceCounts.harvest}`);
  console.log(`⚠️  No contact: ${noContact}`);
  console.log(`❌ Errors: ${errors}`);
  console.log(`📞 Apollo quota used: ${apolloQuotaUsed} (${apolloUsedToday + apolloQuotaUsed}/${APOLLO_DAILY_LIMIT} total today)`);
  console.log(`${'='.repeat(70)}\n`);

  await pool.end();
}

process.on('SIGINT', async () => {
  console.log('\n\n⏹️  Stopping...');
  await pool.end();
  process.exit(0);
});

main().catch(async error => {
  console.error('\n❌ Fatal error:', error);
  await pool.end();
  process.exit(1);
});
