#!/usr/bin/env npx tsx

/**
 * Verify Emails for Unenriched Scans
 *
 * Checks if completed scans (not yet enriched) have a qualified buyer with email
 * using Apollo's people search API. Marks scans without emails so we skip
 * them during enrichment.
 *
 * Cost (BATCHED - efficient):
 *   - 1 credit per 100 domains checked
 *   - 1000 scans = ~10 credits (instead of 1000 with individual searches)
 *
 * Usage:
 *   npm run verify:emails -- --limit=1000
 *   npm run verify:emails -- --limit=1000 --dry-run
 *   npm run verify:emails -- --status
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import { getPool } from '../lib/database.js';

dotenv.config();

// Use shared database configuration (Supabase takes priority)
const db = getPool();

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
// Batch size for people search (1 credit per batch)
const BATCH_SIZE = 100;

if (!APOLLO_API_KEY) {
  console.error('ERROR: APOLLO_API_KEY not found in .env');
  process.exit(1);
}

// Qualified buyer titles
const QUALIFIED_TITLES = [
  'CEO', 'CTO', 'CFO', 'COO', 'CIO', 'CISO',
  'Owner', 'Founder', 'Co-Founder', 'President',
  'Vice President', 'VP',
  'Director', 'Head of',
  'Managing Partner', 'Partner',
  'General Manager'
];

interface ScanToVerify {
  scan_id: string;
  domain: string;
}

/**
 * BATCHED check: Which domains have qualified buyers with email?
 * Cost: 1 credit per call (up to 100 domains)
 * Returns set of domains that have qualified buyers
 */
async function batchCheckQualifiedBuyers(domains: string[]): Promise<Set<string>> {
  if (domains.length === 0) return new Set();

  try {
    const response = await axios.post(
      'https://api.apollo.io/api/v1/people/search',
      {
        per_page: 100,
        page: 1,
        q_organization_domains: domains.join('\n'),
        person_titles: QUALIFIED_TITLES,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': APOLLO_API_KEY,
        },
        timeout: 30000,
      }
    );

    const people = response.data.people || [];
    const qualifiedDomains = new Set<string>();

    for (const person of people) {
      // Check if person has email available (email_status !== 'unavailable')
      if (person.email_status !== 'unavailable') {
        const domain = person.organization?.primary_domain;
        if (domain) {
          qualifiedDomains.add(domain.toLowerCase());
        }
      }
    }

    return qualifiedDomains;
  } catch (error: any) {
    if (error.response?.status === 429) {
      console.log('\n⚠️  Rate limited - waiting 60s...');
      await new Promise(r => setTimeout(r, 60000));
      return batchCheckQualifiedBuyers(domains); // Retry
    }
    console.error(`\n  Batch check error:`, error.message);
    // On error, return all domains as qualified (don't block)
    return new Set(domains);
  }
}

async function getScansToVerify(limit: number): Promise<ScanToVerify[]> {
  // Get unenriched scans that:
  // 1. Are completed with findings
  // 2. Don't have a campaign_contact yet
  // 3. Domain not already enriched
  // 4. Haven't been marked as no_email yet
  const result = await db.query(`
    WITH already_enriched_domains AS (
      SELECT DISTINCT s.domain
      FROM campaign_contacts cc
      JOIN scans s ON s.id = cc.scan_id
    ),
    no_email_domains AS (
      SELECT DISTINCT domain
      FROM scan_email_status
      WHERE has_qualified_email = false
    )
    SELECT s.id as scan_id, s.domain
    FROM scans s
    LEFT JOIN campaign_contacts cc ON cc.scan_id = s.id
    WHERE s.status = 'completed'
      AND s.findings_count > 0
      AND cc.id IS NULL
      AND s.domain NOT IN (SELECT domain FROM already_enriched_domains)
      AND s.domain NOT IN (SELECT domain FROM no_email_domains)
      AND NOT EXISTS (
        SELECT 1 FROM scan_email_status ses WHERE ses.scan_id = s.id
      )
    ORDER BY s.created_at DESC
    LIMIT $1
  `, [limit]);

  return result.rows;
}

async function markEmailStatus(scanId: string, domain: string, hasEmail: boolean): Promise<void> {
  await db.query(`
    INSERT INTO scan_email_status (scan_id, domain, has_qualified_email, checked_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (scan_id) DO UPDATE SET
      has_qualified_email = $3,
      checked_at = NOW()
  `, [scanId, domain, hasEmail]);
}

async function ensureStatusTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS scan_email_status (
      id SERIAL PRIMARY KEY,
      scan_id TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      has_qualified_email BOOLEAN NOT NULL,
      checked_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scan_email_status_domain ON scan_email_status(domain);
    CREATE INDEX IF NOT EXISTS idx_scan_email_status_has_email ON scan_email_status(has_qualified_email);
  `);
}

async function showStatus(): Promise<void> {
  console.log('\n📊 Email Verification Status\n');

  const statusResult = await db.query(`
    SELECT
      has_qualified_email,
      COUNT(*) as count
    FROM scan_email_status
    GROUP BY has_qualified_email
  `);

  let verified = 0, hasEmail = 0, noEmail = 0;
  for (const row of statusResult.rows) {
    verified += parseInt(row.count);
    if (row.has_qualified_email) hasEmail += parseInt(row.count);
    else noEmail += parseInt(row.count);
  }

  const remainingResult = await db.query(`
    WITH already_enriched_domains AS (
      SELECT DISTINCT s.domain
      FROM campaign_contacts cc
      JOIN scans s ON s.id = cc.scan_id
    )
    SELECT COUNT(*) as remaining
    FROM scans s
    LEFT JOIN campaign_contacts cc ON cc.scan_id = s.id
    LEFT JOIN scan_email_status ses ON ses.scan_id = s.id
    WHERE s.status = 'completed'
      AND s.findings_count > 0
      AND cc.id IS NULL
      AND s.domain NOT IN (SELECT domain FROM already_enriched_domains)
      AND ses.id IS NULL
  `);

  const remaining = parseInt(remainingResult.rows[0].remaining);

  console.log(`Verified: ${verified.toLocaleString()}`);
  console.log(`  ✅ Has qualified email: ${hasEmail.toLocaleString()}`);
  console.log(`  ❌ No qualified email: ${noEmail.toLocaleString()}`);
  console.log(`  📊 Hit rate: ${verified > 0 ? ((hasEmail / verified) * 100).toFixed(1) : 0}%`);
  console.log(`\nRemaining to verify: ${remaining.toLocaleString()}`);

  if (remaining > 0) {
    const creditsNeeded = Math.ceil(remaining / BATCH_SIZE);
    console.log(`Credits needed: ~${creditsNeeded} (batched at ${BATCH_SIZE}/credit)`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  await ensureStatusTable();

  if (args.includes('--status')) {
    await showStatus();
    await db.end();
    return;
  }

  const limitArg = args.find(a => a.startsWith('--limit='));
  const dryRun = args.includes('--dry-run');

  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 1000;

  console.log('📧 Email Verification for Unenriched Scans (BATCHED)');
  console.log(`   Limit: ${limit}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log(`   Cost: ~${Math.ceil(limit / BATCH_SIZE)} credits for ${limit} domains`);
  console.log();

  const scans = await getScansToVerify(limit);

  if (scans.length === 0) {
    console.log('✅ No scans to verify - all done!');
    await showStatus();
    await db.end();
    return;
  }

  console.log(`Found ${scans.length} scans to verify\n`);

  if (dryRun) {
    console.log('Dry run - not checking Apollo');
    await db.end();
    return;
  }

  let hasEmailCount = 0;
  let noEmailCount = 0;
  let creditsUsed = 0;

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < scans.length; i += BATCH_SIZE) {
    const batch = scans.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(scans.length / BATCH_SIZE);

    process.stdout.write(`\r[Batch ${batchNum}/${totalBatches}] Checking ${batch.length} domains...`);

    // Get all domains in this batch
    const domains = batch.map(s => s.domain);

    // Batch check all domains at once (1 credit)
    const qualifiedDomains = await batchCheckQualifiedBuyers(domains);
    creditsUsed++;

    // Mark status for each scan in batch
    for (const scan of batch) {
      const hasEmail = qualifiedDomains.has(scan.domain.toLowerCase());
      await markEmailStatus(scan.scan_id, scan.domain, hasEmail);

      if (hasEmail) {
        hasEmailCount++;
      } else {
        noEmailCount++;
      }
    }

    console.log(` ✅ ${qualifiedDomains.size} with email, ❌ ${batch.length - qualifiedDomains.size} without`);

    // Small delay between batches to be nice to the API
    if (i + BATCH_SIZE < scans.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Verification Results');
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Has qualified email: ${hasEmailCount}`);
  console.log(`❌ No qualified email: ${noEmailCount}`);
  console.log(`📊 Hit rate: ${((hasEmailCount / scans.length) * 100).toFixed(1)}%`);
  console.log(`💳 Credits used: ${creditsUsed}`);
  console.log(`\nCheck status: npm run verify:emails -- --status`);
  console.log(`${'='.repeat(60)}\n`);

  await db.end();
}

main().catch(async (error) => {
  console.error('\n❌ Fatal error:', error);
  await db.end();
  process.exit(1);
});
