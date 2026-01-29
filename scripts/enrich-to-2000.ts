#!/usr/bin/env npx tsx

/**
 * Batch Enrichment to 2000 Total
 *
 * Runs 200-company batches until we reach 2000 total enrichments.
 * Never re-enriches companies already in campaign_contacts.
 * STRICT RATE LIMITING: Max 350 calls/hour (leaves 50 buffer from 400 limit)
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { createHarvestClientFromEnv } from '../apps/campaigns/core/harvest-client.js';
import { findBestRoleEmail } from '../apps/campaigns/core/role-email-finder.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

const BATCH_SIZE = 200;
const TARGET_TOTAL = 2000;
const DELAY_MS = 2000; // 2 seconds between companies
const MAX_CALLS_PER_HOUR = 350; // Conservative limit (Apollo allows 400)
const HOUR_MS = 60 * 60 * 1000;

// Track API calls for rate limiting
let apiCallTimestamps: number[] = [];

function recordApiCall() {
  const now = Date.now();
  apiCallTimestamps.push(now);

  // Clean up old timestamps (older than 1 hour)
  const hourAgo = now - HOUR_MS;
  apiCallTimestamps = apiCallTimestamps.filter(ts => ts > hourAgo);
}

function getCallsInLastHour(): number {
  const hourAgo = Date.now() - HOUR_MS;
  apiCallTimestamps = apiCallTimestamps.filter(ts => ts > hourAgo);
  return apiCallTimestamps.length;
}

function canMakeApiCall(): boolean {
  return getCallsInLastHour() < MAX_CALLS_PER_HOUR;
}

function timeUntilNextSlot(): number {
  if (apiCallTimestamps.length === 0) return 0;

  const oldestCall = apiCallTimestamps[0];
  const timeUntilExpiry = (oldestCall + HOUR_MS) - Date.now();
  return Math.max(0, timeUntilExpiry);
}

async function getCurrentCount(): Promise<number> {
  const result = await pool.query('SELECT COUNT(*) FROM campaign_contacts');
  return parseInt(result.rows[0].count);
}

async function getNextBatch(batchSize: number): Promise<any[]> {
  const result = await pool.query(`
    SELECT
      s.id as scan_id,
      s.domain,
      s.metadata->>'company_name' as company_name,
      s.campaign_type
    FROM scans s
    WHERE s.campaign_type IS NOT NULL
      AND s.domain NOT IN (SELECT domain FROM campaign_contacts)
    ORDER BY
      CASE s.campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer' THEN 2
        WHEN 'email_security' THEN 3
        WHEN 'ada' THEN 4
        ELSE 5
      END,
      s.created_at DESC
    LIMIT $1
  `, [batchSize]);

  return result.rows;
}

async function enrichCompany(company: any, index: number, total: number, apolloClient: any) {
  console.log(`\n[${index}/${total}] ${'━'.repeat(30)}`);
  console.log(`🔍 ${company.company_name || company.domain}`);
  console.log(`   Campaign: ${company.campaign_type}`);
  console.log(`   Domain: ${company.domain}`);

  // Check rate limit BEFORE making call
  if (!canMakeApiCall()) {
    const waitMs = timeUntilNextSlot();
    console.log(`   ⏸️  Rate limit: ${getCallsInLastHour()}/${MAX_CALLS_PER_HOUR} calls in last hour`);
    console.log(`   ⏳ Waiting ${Math.ceil(waitMs / 1000 / 60)} minutes for rate limit to reset...`);
    return { success: false, reason: 'rate_limit_preventive', waitMs };
  }

  try {
    recordApiCall(); // Count this call
    const contact = await apolloClient.findExecutiveContact(company.domain);

    if (!contact) {
      console.log('   ⚠️  No executive found via Apollo');

      // Try Harvest API to search company for executives
      const harvestClient = createHarvestClientFromEnv();
      if (harvestClient) {
        console.log('   🔄 Trying Harvest API to find executives at company...');
        try {
          const executives = await harvestClient.findExecutivesAtCompany(company.domain);

          if (executives.length > 0) {
            const exec = executives[0];
            console.log(`   ✅ Harvest found: ${exec.name} (${exec.title})`);
            console.log(`      Email: ${exec.email}`);
            console.log('   💾 Saving to database...');

            const nameParts = exec.name.split(' ');
            const firstName = nameParts[0] || null;
            const lastName = nameParts.slice(1).join(' ') || null;

            const insertResult = await pool.query(`
              INSERT INTO campaign_contacts (
                id, scan_id, domain, company_name, first_name, last_name,
                full_name, title, email, personal_emails, linkedin_url,
                apollo_person_id, campaign_type, status
              ) VALUES (
                'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
                $1, $2, $3, $4, $5, $6, $7, $8, '{}', $9, NULL, $10, 'enriched'
              )
              RETURNING id
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
              company.campaign_type
            ]);

            console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
            return { success: true };
          } else {
            console.log('   ⚠️  Harvest found no executives with emails');
          }
        } catch (harvestError: any) {
          console.log(`   ⚠️  Harvest search failed: ${harvestError.message}`);
        }
      }

      // Try role-based email fallback (for WordPress and email_security campaigns)
      if (company.campaign_type === 'wordpress' || company.campaign_type === 'email_security') {
        console.log('   🔄 Trying role-based emails...');
        const roleEmail = await findBestRoleEmail(company.domain, { verifySmtp: false }); // Skip SMTP for speed

        if (roleEmail) {
          console.log(`   ✅ Found role email: ${roleEmail.email} (${roleEmail.role})`);
          console.log('   💾 Saving to database...');

          const insertResult = await pool.query(`
            INSERT INTO campaign_contacts (
              id, scan_id, domain, company_name, first_name, last_name,
              full_name, title, email, personal_emails, linkedin_url,
              apollo_person_id, campaign_type, status
            ) VALUES (
              'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
              $1, $2, $3, NULL, NULL, $4, $5, $6, '{}', NULL, NULL, $7, 'enriched'
            )
            RETURNING id
          `, [
            company.scan_id,
            company.domain,
            company.company_name,
            roleEmail.role, // Use role as full_name
            roleEmail.role, // Use role as title
            roleEmail.email,
            company.campaign_type
          ]);

          console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
          return { success: true };
        } else {
          console.log('   ⚠️  No role emails found either');
        }
      }

      return { success: false, reason: 'no_contact' };
    }

    if (!contact.email) {
      console.log(`   ⚠️  Found ${contact.title} but no email`);
      return { success: false, reason: 'no_email' };
    }

    console.log(`   ✅ ${contact.name} (${contact.title})`);
    console.log(`      Email: ${contact.email}`);

    console.log('   💾 Saving to database...');
    const insertResult = await pool.query(`
      INSERT INTO campaign_contacts (
        id, scan_id, domain, company_name, first_name, last_name,
        full_name, title, email, personal_emails, linkedin_url,
        apollo_person_id, campaign_type, status
      ) VALUES (
        'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'enriched'
      )
      RETURNING id
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
      company.campaign_type
    ]);

    console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
    return { success: true };

  } catch (error: any) {
    // Rate limit errors should stop the batch immediately
    if (error.message?.includes('429') || error.message?.includes('rate limit')) {
      console.log('   ❌ RATE LIMIT HIT - Stopping batch immediately');
      return { success: false, reason: 'rate_limit', fatal: true };
    }
    console.log(`   ❌ Error: ${error.message}`);
    return { success: false, reason: 'error' };
  }
}

async function runBatch(batchNumber: number, currentTotal: number): Promise<{ processed: number, succeeded: number, hitRateLimit: boolean }> {
  const remaining = TARGET_TOTAL - currentTotal;
  const batchSize = Math.min(BATCH_SIZE, remaining);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`📦 Batch ${batchNumber} - Processing ${batchSize} companies`);
  console.log(`   Current total: ${currentTotal}/${TARGET_TOTAL}`);
  console.log(`   API calls in last hour: ${getCallsInLastHour()}/${MAX_CALLS_PER_HOUR}`);
  console.log(`${'='.repeat(70)}`);

  const companies = await getNextBatch(batchSize);

  if (companies.length === 0) {
    console.log('\n⚠️  No more companies to enrich');
    return { processed: 0, succeeded: 0, hitRateLimit: false };
  }

  console.log(`\nFound ${companies.length} companies to enrich`);

  const campaignCounts = companies.reduce((acc: any, c) => {
    acc[c.campaign_type] = (acc[c.campaign_type] || 0) + 1;
    return acc;
  }, {});
  console.log(`Campaign types: ${Object.entries(campaignCounts).map(([k,v]) => `${k}=${v}`).join(', ')}`);

  const apolloClient = createApolloClientFromEnv();
  let succeeded = 0;
  let noContact = 0;
  let noEmail = 0;
  let errors = 0;
  let rateLimitPreventive = 0;

  for (let i = 0; i < companies.length; i++) {
    const result = await enrichCompany(companies[i], i + 1, companies.length, apolloClient);

    // Fatal rate limit hit - stop immediately
    if (result.fatal) {
      console.log('\n❌ Rate limit hit - stopping this batch early');
      return { processed: i + 1, succeeded, hitRateLimit: true };
    }

    // Preventive rate limit - wait for reset
    if (result.reason === 'rate_limit_preventive' && result.waitMs) {
      console.log(`\n⏳ Pausing batch for ${Math.ceil(result.waitMs / 1000 / 60)} minutes...`);
      await new Promise(resolve => setTimeout(resolve, result.waitMs + 5000)); // Add 5s buffer

      // Retry this company
      const retryResult = await enrichCompany(companies[i], i + 1, companies.length, apolloClient);
      if (retryResult.success) {
        succeeded++;
      } else if (retryResult.fatal) {
        return { processed: i + 1, succeeded, hitRateLimit: true };
      } else if (retryResult.reason === 'no_contact') {
        noContact++;
      } else if (retryResult.reason === 'no_email') {
        noEmail++;
      } else {
        errors++;
      }
    } else if (result.success) {
      succeeded++;
    } else if (result.reason === 'no_contact') {
      noContact++;
    } else if (result.reason === 'no_email') {
      noEmail++;
    } else if (result.reason === 'rate_limit_preventive') {
      rateLimitPreventive++;
    } else {
      errors++;
    }

    if (i < companies.length - 1) {
      console.log(`   ⏸️  Waiting ${DELAY_MS/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Batch ${batchNumber} Results`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total processed: ${companies.length}`);
  console.log(`✅ Success (saved to DB): ${succeeded} (${Math.round(succeeded/companies.length*100)}%)`);
  console.log(`⚠️  No contact found: ${noContact}`);
  console.log(`⚠️  Contact but no email: ${noEmail}`);
  console.log(`❌ Errors: ${errors}`);
  console.log(`🔒 Rate limit pauses: ${rateLimitPreventive}`);
  console.log(`📞 API calls in last hour: ${getCallsInLastHour()}/${MAX_CALLS_PER_HOUR}`);
  console.log(`${'='.repeat(70)}\n`);

  return { processed: companies.length, succeeded, hitRateLimit: false };
}

async function main() {
  console.log('🚀 Batch Enrichment to 2000 Total');
  console.log(`   Rate limit: ${MAX_CALLS_PER_HOUR} calls/hour (safe buffer from 400 limit)\n`);

  const startingCount = await getCurrentCount();
  console.log(`Starting count: ${startingCount}/${TARGET_TOTAL}\n`);

  if (startingCount >= TARGET_TOTAL) {
    console.log(`✅ Already at or above target (${startingCount}/${TARGET_TOTAL})`);
    process.exit(0);
  }

  let batchNumber = 1;
  let totalSucceeded = 0;

  while (true) {
    const currentTotal = await getCurrentCount();

    if (currentTotal >= TARGET_TOTAL) {
      console.log(`\n✅ Target reached! ${currentTotal}/${TARGET_TOTAL} contacts enriched`);
      break;
    }

    const result = await runBatch(batchNumber, currentTotal);
    totalSucceeded += result.succeeded;

    if (result.hitRateLimit) {
      console.log('\n⚠️  Rate limit hit - stopping enrichment');
      console.log('Run this script again later when the hourly limit resets.');
      break;
    }

    if (result.processed === 0) {
      console.log('\n⚠️  No more companies available to enrich');
      break;
    }

    batchNumber++;

    // Small delay between batches
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const finalCount = await getCurrentCount();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Final Summary`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Starting count: ${startingCount}`);
  console.log(`Batches run: ${batchNumber}`);
  console.log(`Successfully enriched this session: ${totalSucceeded}`);
  console.log(`Final total: ${finalCount}/${TARGET_TOTAL}`);
  console.log(`API calls made: ${getCallsInLastHour()} in last hour`);
  console.log(`${'='.repeat(70)}\n`);

  await pool.end();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n⏹️  Stopping enrichment...');
  console.log(`API calls made: ${getCallsInLastHour()} in last hour`);
  await pool.end();
  process.exit(0);
});

main().catch(async error => {
  console.error('\n❌ Fatal error:', error);
  await pool.end();
  process.exit(1);
});
