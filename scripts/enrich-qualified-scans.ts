#!/usr/bin/env npx tsx

/**
 * Enrich Qualified Scans
 *
 * Purpose: Enrich contacts for completed scans that have STRONG findings,
 * regardless of when they were scanned.
 *
 * Qualification Criteria:
 *   - Infostealer/password breach exposure
 *   - WordPress vulnerabilities
 *   - ADA/compliance losses ≥ $35k
 *   - Cyber EAL > $50k (excluding breach-driven)
 *
 * Filters Applied:
 *   - Root domains only (no subdomains)
 *   - Company size: ≤500 employees, ≤$500M revenue
 *   - Not already enriched
 *
 * Usage:
 *   npm run experiment:enrich:qualified -- --limit=200
 */

import { createApolloClientFromEnv, ApolloPerson } from '../apps/campaigns/core/apollo-client.js';
import { createHarvestClientFromEnv } from '../apps/campaigns/core/harvest-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

const DELAY_MS = 2000; // 2 seconds between companies
const MAX_CALLS_PER_HOUR = 350; // Conservative Apollo limit
const MAX_REVENUE = 500_000_000; // $500M - skip companies bigger than this
const MAX_EMPLOYEES = 500; // Skip companies with more than 500 employees (SMB focus)

// Role-based email prefixes to skip (these are generic addresses, not personal contacts)
const ROLE_BASED_PREFIXES = [
  'security@', 'info@', 'contact@', 'hello@', 'admin@', 'support@',
  'sales@', 'team@', 'help@', 'office@', 'hr@', 'careers@', 'jobs@',
  'catchall@', 'noreply@', 'no-reply@', 'webmaster@', 'postmaster@'
];

function isRoleBasedEmail(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  return ROLE_BASED_PREFIXES.some(prefix => lowerEmail.startsWith(prefix));
}

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

  // Priority 1: Infostealer
  if (findingTypes.has('CRITICAL_BREACH_EXPOSURE')) {
    return 'infostealer_credentials';
  }

  // Priority 2: WordPress
  if (findingTypes.has('WP_PLUGIN_VULNERABILITY')) {
    return 'wordpress';
  }

  // Priority 3: Next.js RSC
  if (findingTypes.has('NEXTJS_RSC_RCE_EXPOSURE')) {
    return 'nextjs_rsc';
  }

  // Priority 4: ADA Accessibility
  if (findingTypes.has('ACCESSIBILITY_OBSERVATION') || findingTypes.has('ADA_RISK_BAND')) {
    return 'ada_accessibility';
  }

  // Priority 5: Email Security
  if (findingTypes.has('EMAIL_SECURITY_GAP') ||
      findingTypes.has('EMAIL_SECURITY_WEAKNESS') ||
      findingTypes.has('EMAIL_SECURITY_MISCONFIGURATION')) {
    return 'email_security';
  }

  // Fallback - should rarely happen since we only enrich qualified scans
  return 'email_security';
}

async function getQualifiedScans(limit: number, offset: number = 0): Promise<any[]> {
  // Get scans with strong findings that haven't been enriched yet
  const result = await pool.query(`
    WITH qualified AS (
      SELECT DISTINCT s.id as scan_id, s.domain, s.metadata->>'company_name' as company_name, s.created_at
      FROM scans s
      JOIN findings f ON f.scan_id = s.id
      LEFT JOIN scan_eal_summary eal ON eal.scan_id = s.id
      WHERE s.status = 'completed'
        -- Not already enriched
        AND s.domain NOT IN (SELECT domain FROM campaign_contacts WHERE domain IS NOT NULL)
        -- Strong findings qualification
        AND (
          -- Infostealer/password breach exposure
          f.type IN ('BREACHED_PASSWORDS', 'INFOSTEALER_EXPOSURE', 'BREACH_DIRECTORY_EXPOSURE')
          -- WordPress vulnerabilities
          OR f.type IN ('WORDPRESS_VULNERABILITY', 'OUTDATED_WORDPRESS')
          -- ADA/compliance >= $35k
          OR (f.type IN ('ACCESSIBILITY_VIOLATION', 'ACCESSIBILITY_ERROR') AND COALESCE(f.eal_ml, 0) >= 35000)
          -- Cyber EAL > $50k (uses summary for efficiency)
          OR COALESCE(eal.total_eal_ml, 0) > 50000
        )
        -- Root domains only (2 parts max)
        AND array_length(string_to_array(s.domain, '.'), 1) <= 2
      ORDER BY s.created_at DESC
    )
    SELECT * FROM qualified
    OFFSET $1
    LIMIT $2
  `, [offset, limit]);

  // Additional filter for edge cases (2-part TLDs like co.uk)
  const filtered = result.rows.filter(row => !isSubdomain(row.domain));
  return filtered;
}

async function enrichCompany(
  company: any,
  index: number,
  total: number,
  apolloClient: any,
  harvestClient: any,
  preFetchedPerson: ApolloPerson | null | undefined
) {
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

    // 1. Try Apollo for contact - use pre-fetched person if available (SAVES 1 CREDIT!)
    let contact: ApolloPerson | null = null;

    if (preFetchedPerson) {
      console.log(`   💰 Using pre-fetched person: ${preFetchedPerson.name || preFetchedPerson.title}`);

      // Check if pre-fetched person already has email (no enrichment needed!)
      const hasEmailFromPreFetch = preFetchedPerson.email ||
        (preFetchedPerson.personal_emails && preFetchedPerson.personal_emails.length > 0);

      if (hasEmailFromPreFetch) {
        console.log('   🎉 Pre-fetch already has email - ZERO credits for this contact!');
        contact = preFetchedPerson;
      } else {
        // Only enrich to get email (1 credit instead of 2)
        recordApiCall();
        console.log('   🔄 Enriching pre-fetched person (1 credit)...');
        contact = await apolloClient.enrichPreFetchedPerson(preFetchedPerson);
      }
    } else {
      // No pre-fetched person - fall back to full search (2 credits)
      recordApiCall();
      console.log('   🔄 No pre-fetch - full Apollo search (2 credits)...');
      contact = await apolloClient.findExecutiveContact(company.domain);
    }

    // Determine best email (work email preferred, personal as fallback)
    const bestEmail = contact?.email ||
      (contact?.personal_emails && contact.personal_emails.length > 0 ? contact.personal_emails[0] : null);

    if (contact && bestEmail) {
      // Skip role-based emails
      if (isRoleBasedEmail(bestEmail)) {
        console.log(`   ⚠️  Apollo: Skipping role-based email: ${bestEmail}`);
      } else {
      console.log(`   ✅ Apollo: ${contact.name} (${contact.title})`);
      console.log(`      Email: ${bestEmail}`);
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
        contact.first_name,
        contact.last_name,
        contact.name,
        contact.title,
        bestEmail,  // Use the best available email
        contact.personal_emails || [],
        contact.linkedin_url,
        contact.id,
        campaignType
      ]);

      console.log(`   ✅ Saved (source: apollo)`);
      return { success: true, source: 'apollo' };
      }
    }

    console.log('   ⚠️  Apollo: No executive found');

    // 2. Try Harvest
    if (harvestClient) {
      console.log('   🔄 Trying Harvest...');
      const executives = await harvestClient.findExecutivesAtCompany(company.domain);

      if (executives.length > 0) {
        const exec = executives[0];

        // Skip role-based emails
        if (isRoleBasedEmail(exec.email)) {
          console.log(`   ⚠️  Harvest: Skipping role-based email: ${exec.email}`);
        } else {
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
  const limitArg = args.find(a => a.startsWith('--limit='));
  const offsetArg = args.find(a => a.startsWith('--offset='));
  const dryRun = args.includes('--dry-run');

  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 200;
  const offset = offsetArg ? parseInt(offsetArg.split('=')[1]) : 0;

  console.log('🚀 Enrich Qualified Scans');
  console.log(`   Limit: ${limit} scans`);
  console.log(`   Offset: ${offset}`);
  console.log(`   Rate limit: ${MAX_CALLS_PER_HOUR} calls/hour`);
  console.log(`   Company size filter: ≤${MAX_EMPLOYEES} employees, ≤$${MAX_REVENUE/1_000_000}M revenue`);
  console.log(`   Dry run: ${dryRun}\n`);

  // Count total qualified scans
  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT s.id) as total
    FROM scans s
    JOIN findings f ON f.scan_id = s.id
    LEFT JOIN scan_eal_summary eal ON eal.scan_id = s.id
    WHERE s.status = 'completed'
      AND s.domain NOT IN (SELECT domain FROM campaign_contacts WHERE domain IS NOT NULL)
      AND (
        f.type IN ('BREACHED_PASSWORDS', 'INFOSTEALER_EXPOSURE', 'BREACH_DIRECTORY_EXPOSURE')
        OR f.type IN ('WORDPRESS_VULNERABILITY', 'OUTDATED_WORDPRESS')
        OR (f.type IN ('ACCESSIBILITY_VIOLATION', 'ACCESSIBILITY_ERROR') AND COALESCE(f.eal_ml, 0) >= 35000)
        OR COALESCE(eal.total_eal_ml, 0) > 50000
      )
      AND array_length(string_to_array(s.domain, '.'), 1) <= 2
  `);

  console.log(`📊 Total qualified scans remaining: ${countResult.rows[0].total}\n`);

  // Initialize Apollo client
  const apolloClient = createApolloClientFromEnv();

  // Get scans to enrich
  const scans = await getQualifiedScans(limit, offset);

  if (scans.length === 0) {
    console.log('✅ No more qualified scans need enrichment');
    await pool.end();
    process.exit(0);
  }

  console.log(`Found ${scans.length} scans to enrich (batch starting at offset ${offset})\n`);

  if (dryRun) {
    console.log('DRY RUN - would process these domains:');
    for (const scan of scans.slice(0, 20)) {
      console.log(`  - ${scan.domain} (${scan.company_name || 'unknown'})`);
    }
    if (scans.length > 20) {
      console.log(`  ... and ${scans.length - 20} more`);
    }
    await pool.end();
    return;
  }

  const harvestClient = createHarvestClientFromEnv();

  // CREDIT OPTIMIZATION: Pre-fetch person IDs for all domains in batch (1 credit per ~100 domains)
  // This saves 1 credit per company compared to individual searches
  console.log(`\n💰 CREDIT OPTIMIZATION: Pre-fetching person IDs for ${scans.length} domains...`);
  const domains = scans.map(s => s.domain);

  // Process in batches of 100 (1 credit per batch)
  const preFetchedPersons = new Map<string, ApolloPerson | null>();
  const PREFETCH_BATCH_SIZE = 100;

  for (let i = 0; i < domains.length; i += PREFETCH_BATCH_SIZE) {
    const batch = domains.slice(i, i + PREFETCH_BATCH_SIZE);
    console.log(`   Batch ${Math.floor(i / PREFETCH_BATCH_SIZE) + 1}: ${batch.length} domains (1 credit)...`);
    recordApiCall();

    const batchResults = await apolloClient.batchPreFetchExecutives(batch);
    Array.from(batchResults.entries()).forEach(([domain, person]) => {
      preFetchedPersons.set(domain, person);
    });

    // Small delay between batches
    if (i + PREFETCH_BATCH_SIZE < domains.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const foundPersons = Array.from(preFetchedPersons.values()).filter(p => p !== null).length;
  console.log(`   Pre-fetch complete: found ${foundPersons}/${domains.length} persons`);
  console.log(`   Credits used for pre-fetch: ${Math.ceil(domains.length / PREFETCH_BATCH_SIZE)}`);
  console.log(`   Credits SAVED (vs individual searches): ${foundPersons}\n`);

  let succeeded = 0;
  let noContact = 0;
  let errors = 0;
  let skippedTooLarge = 0;
  let sourceCounts = { apollo: 0, harvest: 0 };

  for (let i = 0; i < scans.length; i++) {
    const preFetchedPerson = preFetchedPersons.get(scans[i].domain.toLowerCase());
    const result = await enrichCompany(scans[i], i + 1, scans.length, apolloClient, harvestClient, preFetchedPerson);

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
  console.log(`\n💡 Next run: npm run experiment:enrich:qualified -- --limit=${limit} --offset=${offset + scans.length}`);
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
