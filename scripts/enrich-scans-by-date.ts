#!/usr/bin/env npx tsx

/**
 * Direct Scan Enrichment by Date Range
 *
 * Enriches contacts for completed scans from a specific date,
 * regardless of how they were submitted (API loader, discovery pipeline, etc).
 * Uses Apollo → Harvest waterfall to find executive contacts.
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { createHarvestClientFromEnv } from '../apps/campaigns/core/harvest-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

const DELAY_MS = 2000; // 2 seconds between companies
const MAX_CALLS_PER_HOUR = 350; // Conservative Apollo limit
const MAX_REVENUE = 500_000_000; // $500M - skip companies bigger than this
const MAX_EMPLOYEES = 500; // Skip companies with more than 500 employees (SMB focus)

// Track API calls for rate limiting
let apiCallTimestamps: number[] = [];

function recordApiCall() {
  const now = Date.now();
  apiCallTimestamps.push(now);

  // Clean up old timestamps
  const hourAgo = now - (60 * 60 * 1000);
  apiCallTimestamps = apiCallTimestamps.filter(ts => ts > hourAgo);
}

function getCallsInLastHour(): number {
  const hourAgo = Date.now() - (60 * 60 * 1000);
  apiCallTimestamps = apiCallTimestamps.filter(ts => ts > hourAgo);
  return apiCallTimestamps.length;
}

function canMakeApiCall(): boolean {
  return getCallsInLastHour() < MAX_CALLS_PER_HOUR;
}

// Check if domain is a subdomain (not a root domain)
function isSubdomain(domain: string): boolean {
  const parts = domain.split('.');
  // Root domain has 2 parts (example.com), subdomain has 3+ (sub.example.com)
  // Exception for 2-part TLDs like co.uk, com.au
  if (parts.length <= 2) return false;
  if (parts.length === 3) {
    const twoPartTLDs = ['co.uk', 'com.au', 'com.br', 'co.nz', 'co.za', 'co.in', 'com.mx', 'co.jp', 'co.kr', 'com.cn'];
    const lastTwo = parts.slice(-2).join('.');
    if (twoPartTLDs.includes(lastTwo)) return false;
  }
  return true;
}

/**
 * Determine campaign_type based on scan findings.
 * Priority order (highest to lowest):
 * 1. infostealer_credentials - CRITICAL_BREACH_EXPOSURE
 * 2. wordpress - WP_PLUGIN_VULNERABILITY
 * 3. nextjs_rsc - NEXTJS_RSC_RCE_EXPOSURE
 * 4. ada_accessibility - ACCESSIBILITY_OBSERVATION, ADA_RISK_BAND
 * 5. email_security - EMAIL_SECURITY_GAP, EMAIL_SECURITY_WEAKNESS
 */
async function determineCampaignType(scanId: string): Promise<string> {
  const result = await pool.query(`
    SELECT type FROM findings WHERE scan_id = $1
  `, [scanId]);

  const findingTypes = new Set(result.rows.map(r => r.type));

  if (findingTypes.has('CRITICAL_BREACH_EXPOSURE')) return 'infostealer_credentials';
  if (findingTypes.has('WP_PLUGIN_VULNERABILITY')) return 'wordpress';
  if (findingTypes.has('NEXTJS_RSC_RCE_EXPOSURE')) return 'nextjs_rsc';
  if (findingTypes.has('ACCESSIBILITY_OBSERVATION') || findingTypes.has('ADA_RISK_BAND')) return 'ada_accessibility';
  if (findingTypes.has('EMAIL_SECURITY_GAP') || findingTypes.has('EMAIL_SECURITY_WEAKNESS') || findingTypes.has('EMAIL_SECURITY_MISCONFIGURATION')) return 'email_security';

  return 'email_security'; // Fallback
}

async function getScansByDate(dateStr: string, limit: number): Promise<any[]> {
  const result = await pool.query(`
    SELECT
      s.id as scan_id,
      s.domain,
      s.metadata->>'company_name' as company_name,
      s.created_at
    FROM scans s
    WHERE s.created_at::date = $1::date
      AND s.status = 'completed'
      AND s.domain NOT IN (SELECT domain FROM campaign_contacts WHERE domain IS NOT NULL)
      -- Skip subdomains: only enrich root domains
      -- Root domains have 1 dot (example.com), subdomains have 2+ (sub.example.com)
      -- Exception for 2-part TLDs handled in code
      AND array_length(string_to_array(s.domain, '.'), 1) <= 2
    ORDER BY s.created_at DESC
    LIMIT $2
  `, [dateStr, limit]);

  // Additional filter for edge cases (2-part TLDs like co.uk)
  const filtered = result.rows.filter(row => !isSubdomain(row.domain));
  return filtered;
}

async function enrichCompany(company: any, index: number, total: number, apolloClient: any, harvestClient: any) {
  console.log(`\n[${index}/${total}] ${'━'.repeat(50)}`);
  console.log(`🔍 ${company.company_name || company.domain}`);
  console.log(`   Domain: ${company.domain}`);
  console.log(`   Scan: ${company.scan_id}`);

  // Check rate limit
  if (!canMakeApiCall()) {
    console.log(`   ⏸️  Rate limit: ${getCallsInLastHour()}/${MAX_CALLS_PER_HOUR} calls in last hour`);
    return { success: false, reason: 'rate_limit_preventive' };
  }

  // Determine campaign_type based on findings BEFORE enrichment
  const campaignType = await determineCampaignType(company.scan_id);
  console.log(`   🏷️  Campaign type: ${campaignType}`);

  try {
    // 0. Check company size first (free API call - doesn't cost credits)
    console.log('   🔍 Checking company size...');
    const org = await apolloClient.getOrganization(company.domain);

    if (org) {
      const revenue = org.annual_revenue || 0;
      const employees = org.estimated_num_employees || 0;
      const revenuePrinted = org.annual_revenue_printed || 'unknown';

      console.log(`   📊 ${org.name}: ${employees} employees, ${revenuePrinted} revenue`);

      if (revenue > MAX_REVENUE) {
        console.log(`   ⏭️  Skipping: Revenue $${(revenue/1_000_000).toFixed(0)}M exceeds $${MAX_REVENUE/1_000_000}M limit`);
        return { success: false, reason: 'too_large_revenue' };
      }

      if (employees > MAX_EMPLOYEES) {
        console.log(`   ⏭️  Skipping: ${employees} employees exceeds ${MAX_EMPLOYEES} limit`);
        return { success: false, reason: 'too_large_employees' };
      }
    } else {
      console.log('   📊 Company info not found (will try enrichment anyway)');
    }

    // 1. Try Apollo for contact
    recordApiCall();
    console.log('   🔄 Trying Apollo...');
    const contact = await apolloClient.findExecutiveContact(company.domain);

    if (contact && contact.email) {
      console.log(`   ✅ Apollo: ${contact.name} (${contact.title})`);
      console.log(`      Email: ${contact.email}`);
      console.log('   💾 Saving to database...');

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
        company.scan_id,
        company.domain,
        company.company_name,
        contact.firstName,
        contact.lastName,
        contact.name,
        contact.title,
        contact.email,
        contact.personalEmails || [],
        contact.linkedinUrl,
        contact.id,
        campaignType
      ]);

      console.log(`   ✅ Saved (source: apollo)`);
      return { success: true, source: 'apollo' };
    }

    console.log('   ⚠️  Apollo: No executive found');

    // 2. Try Harvest
    if (harvestClient) {
      console.log('   🔄 Trying Harvest...');
      const executives = await harvestClient.findExecutivesAtCompany(company.domain);

      if (executives.length > 0) {
        const exec = executives[0];
        console.log(`   ✅ Harvest: ${exec.name} (${exec.title})`);
        console.log(`      Email: ${exec.email}`);
        console.log('   💾 Saving to database...');

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
          company.scan_id,
          company.domain,
          company.company_name,
          firstName,
          lastName,
          exec.name,
          exec.title,
          exec.email,
          exec.linkedinUrl,
          campaignType
        ]);

        console.log(`   ✅ Saved (source: harvest)`);
        return { success: true, source: 'harvest' };
      }

      console.log('   ⚠️  Harvest: No executives found');
    }

    console.log('   ⚠️  No contact found via Apollo or Harvest');
    return { success: false, reason: 'no_contact' };

  } catch (error: any) {
    if (error.message?.includes('429') || error.message?.includes('rate limit')) {
      console.log('   ❌ RATE LIMIT HIT');
      console.log('   ❌ FULL ERROR:', error.message);
      return { success: false, reason: 'rate_limit', fatal: true };
    }
    console.log(`   ❌ Error: ${error.message}`);
    return { success: false, reason: 'error' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find(a => a.startsWith('--date='));
  const limitArg = args.find(a => a.startsWith('--limit='));

  if (!dateArg) {
    console.error('Usage: npx tsx scripts/enrich-scans-by-date.ts --date=2025-11-24 [--limit=500]');
    console.error('\nEnriches completed scans from a specific date.');
    console.error('Works with any scans (API-loaded, discovery pipeline, etc).');
    process.exit(1);
  }

  const dateStr = dateArg.split('=')[1];
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 500;

  console.log('🚀 Direct Scan Enrichment by Date');
  console.log(`   Date: ${dateStr}`);
  console.log(`   Limit: ${limit} scans`);
  console.log(`   Rate limit: ${MAX_CALLS_PER_HOUR} calls/hour\n`);

  // Initialize Apollo client
  const apolloClient = createApolloClientFromEnv();

  // Get scans to enrich
  const scans = await getScansByDate(dateStr, limit);

  if (scans.length === 0) {
    console.log('✅ No scans need enrichment (all already enriched or no completed scans on that date)');
    await pool.end();
    process.exit(0);
  }

  console.log(`Found ${scans.length} scans to enrich\n`);

  const harvestClient = createHarvestClientFromEnv();

  let succeeded = 0;
  let noContact = 0;
  let errors = 0;
  let skippedTooLarge = 0;
  let sourceCounts = { apollo: 0, harvest: 0 };

  for (let i = 0; i < scans.length; i++) {
    const result = await enrichCompany(scans[i], i + 1, scans.length, apolloClient, harvestClient);

    if (result.fatal) {
      console.log('\n❌ Rate limit hit - stopping early');
      break;
    }

    if (result.reason === 'rate_limit_preventive') {
      console.log('\n⏸️  Rate limit approaching - stopping early');
      console.log('Run again later when limit resets');
      break;
    }

    if (result.success) {
      succeeded++;
      sourceCounts[result.source as keyof typeof sourceCounts]++;
    } else if (result.reason === 'too_large_revenue' || result.reason === 'too_large_employees') {
      skippedTooLarge++;
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
  console.log(`⏭️  Skipped (too large): ${skippedTooLarge}`);
  console.log(`⚠️  No contact: ${noContact}`);
  console.log(`❌ Errors: ${errors}`);
  console.log(`📞 API calls: ${getCallsInLastHour()} in last hour`);
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
