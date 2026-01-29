#!/usr/bin/env npx tsx

/**
 * WordPress Campaign Loader
 *
 * Loads prospects from scans with WordPress plugin vulnerabilities.
 * Uses batched Apollo people search to find contacts.
 * Creates campaign contacts with formatted wp_plugin_list for email template.
 *
 * Flow:
 * 1. Query scans with WP_PLUGIN_VULNERABILITY findings
 * 2. Run batched Apollo people search on domains
 * 3. Enrich contacts for domains with qualified buyers
 * 4. Load into campaign_contacts with campaign_type='wordpress'
 *
 * Usage:
 *   npm run campaign:load:wordpress -- --limit=50
 *   npm run campaign:load:wordpress -- --dry-run
 */

import { config } from 'dotenv';
import { getPool } from '../lib/database.js';
import { createApolloClientFromEnv, ApolloPerson } from '../apps/campaigns/core/apollo-client.js';
import { isPlaceholderEmail, getRealEmail, escapeHtml } from '../lib/campaigns/email.js';

config();

const pool = getPool();

interface WpVulnPlugin {
  plugin: string;
  version: string;
  severity: string;
}

interface WpScanData {
  scan_id: string;
  domain: string;
  company_name: string;
  wp_vuln_count: number;
  wp_vulns: WpVulnPlugin[];
  total_eal_ml: number;
}

async function loadWordPressProspects(options: {
  limit?: number;
  dryRun?: boolean;
  minVulns?: number;
}) {
  const { limit = 100, dryRun = false, minVulns = 1 } = options;

  console.log('\n📦 WordPress Campaign Loader\n');
  console.log(`   Min vulnerabilities: ${minVulns}`);
  console.log(`   Limit: ${limit}`);
  console.log(`   Dry run: ${dryRun}\n`);

  // Query scans with WP_PLUGIN_VULNERABILITY findings
  // Extracts plugin/version/severity from finding descriptions
  // Deduplicates plugins per scan (one entry per plugin with highest severity)
  const scansQuery = await pool.query(`
    WITH wp_findings AS (
      SELECT
        f.scan_id,
        f.description,
        f.severity,
        f.eal_ml,
        (regexp_match(f.description, 'affecting plugin ([a-z0-9_-]+)', 'i'))[1] as plugin,
        COALESCE((regexp_match(f.description, ' v([0-9.]+)'))[1], 'unknown') as version,
        CASE f.severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
          ELSE 5
        END as severity_rank
      FROM findings f
      WHERE f.type = 'WP_PLUGIN_VULNERABILITY'
    ),
    unique_plugins AS (
      SELECT DISTINCT ON (scan_id, plugin)
        scan_id, plugin, version, severity, severity_rank
      FROM wp_findings
      WHERE plugin IS NOT NULL
      ORDER BY scan_id, plugin, severity_rank ASC
    ),
    scan_vulns AS (
      SELECT
        up.scan_id,
        json_agg(json_build_object(
          'plugin', up.plugin,
          'version', up.version,
          'severity', up.severity
        ) ORDER BY up.severity_rank ASC) as vulns,
        COUNT(*) as vuln_count
      FROM unique_plugins up
      GROUP BY up.scan_id
      HAVING COUNT(*) >= $1
    )
    SELECT
      sv.scan_id,
      REPLACE(s.domain, 'www.', '') as domain,
      COALESCE(s.metadata->>'company_name', s.domain) as company_name,
      sv.vuln_count as wp_vuln_count,
      sv.vulns as wp_vulns,
      COALESCE(e.total_eal_ml, 0) as total_eal_ml
    FROM scan_vulns sv
    JOIN scans s ON s.id = sv.scan_id
    LEFT JOIN scan_eal_summary e ON e.scan_id = sv.scan_id
    WHERE s.status = 'completed'
    ORDER BY sv.vuln_count DESC, e.total_eal_ml DESC NULLS LAST
    LIMIT $2
  `, [minVulns, limit]);

  const scans: WpScanData[] = scansQuery.rows;

  console.log(`📊 Found ${scans.length} scans with WordPress vulnerabilities\n`);

  if (scans.length === 0) {
    console.log('No scans found matching criteria.');
    await pool.end();
    return;
  }

  // Collect unique domains and group scans by domain
  const scansByDomain = new Map<string, WpScanData[]>();
  for (const scan of scans) {
    const domain = scan.domain.toLowerCase();
    if (!scansByDomain.has(domain)) {
      scansByDomain.set(domain, []);
    }
    scansByDomain.get(domain)!.push(scan);
  }

  const domains = Array.from(scansByDomain.keys());
  console.log(`🌐 Unique domains to search: ${domains.length}\n`);

  if (dryRun) {
    console.log('DRY RUN - Would search these domains:');
    domains.slice(0, 20).forEach(d => console.log(`   - ${d}`));
    if (domains.length > 20) {
      console.log(`   ... and ${domains.length - 20} more`);
    }

    console.log('\nSample scans:');
    scans.slice(0, 5).forEach(scan => {
      console.log(`   ${scan.company_name} (${scan.domain})`);
      console.log(`      Vulns: ${scan.wp_vuln_count}`);
      console.log(`      Plugins: ${scan.wp_vulns.slice(0, 3).map(v => `${v.plugin} (${v.severity})`).join(', ')}`);
    });

    await pool.end();
    return;
  }

  // Batched Apollo people search
  console.log('💰 Running batched Apollo people search...');
  const apolloClient = createApolloClientFromEnv();

  const BATCH_SIZE = 100;
  const preFetchedPersons = new Map<string, ApolloPerson | null>();

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);
    console.log(`   Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} domains (1 credit)...`);

    const batchResults = await apolloClient.batchPreFetchExecutives(batch);
    Array.from(batchResults.entries()).forEach(([domain, person]) => {
      preFetchedPersons.set(domain, person);
    });

    // Small delay between batches
    if (i + BATCH_SIZE < domains.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const domainsWithContacts = Array.from(preFetchedPersons.entries())
    .filter(([_, person]) => person !== null);

  console.log(`\n✅ Found contacts for ${domainsWithContacts.length}/${domains.length} domains\n`);

  // Enrich and load contacts
  let loaded = 0;
  let skipped = 0;
  let enriched = 0;

  for (const [domain, preFetchedPerson] of domainsWithContacts) {
    const domainScans = scansByDomain.get(domain) || [];
    if (domainScans.length === 0) continue;

    // Use the scan with the most vulnerabilities for this domain
    const bestScan = domainScans.reduce((a, b) => a.wp_vuln_count > b.wp_vuln_count ? a : b);

    // Enrich the person to get email (1 credit)
    let contact: ApolloPerson | null = preFetchedPerson;

    // Check if we already have a REAL email from pre-fetch (not placeholder)
    const hasRealEmailFromPreFetch =
      (!isPlaceholderEmail(preFetchedPerson?.email)) ||
      (preFetchedPerson?.personal_emails && preFetchedPerson.personal_emails.length > 0 &&
       !isPlaceholderEmail(preFetchedPerson.personal_emails[0]));

    if (!hasRealEmailFromPreFetch && preFetchedPerson) {
      console.log(`   🔄 Enriching ${preFetchedPerson.name || domain}...`);
      contact = await apolloClient.enrichPreFetchedPerson(preFetchedPerson);
      enriched++;
    }

    const bestEmail = getRealEmail(contact);

    if (!bestEmail) {
      console.log(`   ⚠️  No email for ${domain}`);
      skipped++;
      continue;
    }

    // Format wp_plugin_list for email template
    // SECURITY: Escape plugin data to prevent HTML injection
    const wpPluginList = bestScan.wp_vulns
      .slice(0, 5)
      .map(v => `<li><strong>${escapeHtml(v.plugin)}</strong> (${escapeHtml(v.version)}) - ${escapeHtml(v.severity)} severity</li>`)
      .join('\n');

    const companyName = bestScan.company_name || contact?.organization?.name || domain;

    // Insert into campaign_contacts
    try {
      await pool.query(`
        INSERT INTO campaign_contacts (
          id, scan_id, domain, company_name, first_name, last_name,
          full_name, title, email, personal_emails, linkedin_url,
          apollo_person_id, campaign_type, status, enrichment_source,
          metadata
        ) VALUES (
          'contact-wp-' || substr(md5(random()::text || clock_timestamp()::text), 1, 16),
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'wordpress', 'enriched', 'apollo',
          $12
        )
        ON CONFLICT (domain, campaign_type) DO UPDATE SET
          email = EXCLUDED.email,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [
        bestScan.scan_id,
        domain,
        companyName,
        contact?.first_name,
        contact?.last_name,
        contact?.name,
        contact?.title,
        bestEmail,
        contact?.personal_emails || [],
        contact?.linkedin_url,
        contact?.id,
        JSON.stringify({
          wp_plugin_list: wpPluginList,
          wp_vuln_count: bestScan.wp_vuln_count,
          wp_vulns: bestScan.wp_vulns.slice(0, 10),
          total_eal_ml: bestScan.total_eal_ml
        })
      ]);

      loaded++;
      console.log(`   ✅ ${companyName} (${domain}) - ${bestScan.wp_vuln_count} vulns`);
    } catch (error: any) {
      console.error(`   ❌ Error loading ${domain}: ${error.message}`);
      skipped++;
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Loading Complete');
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Scans processed: ${scans.length}`);
  console.log(`   Domains searched: ${domains.length}`);
  console.log(`   Contacts found: ${domainsWithContacts.length}`);
  console.log(`   Enrichments: ${enriched}`);
  console.log(`   Loaded: ${loaded}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Apollo credits used: ~${Math.ceil(domains.length / 100) + enriched}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Show sample
  const sample = await pool.query(`
    SELECT company_name, domain, email, metadata->>'wp_vuln_count' as vulns
    FROM campaign_contacts
    WHERE campaign_type = 'wordpress'
    ORDER BY created_at DESC
    LIMIT 5
  `);

  if (sample.rows.length > 0) {
    console.log('📋 Recent WordPress contacts:');
    sample.rows.forEach((row, i) => {
      console.log(`   ${i + 1}. ${row.company_name} (${row.domain}) - ${row.vulns} vulns - ${row.email}`);
    });
  }

  await pool.end();
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
WordPress Campaign Loader

Loads WordPress vulnerability leads into campaign_contacts with Apollo enrichment.

Usage:
  npx tsx scripts/campaign-loader-wordpress.ts [options]

Options:
  --limit <n>          Maximum scans to process (default: 100)
  --min-vulns <n>      Minimum vulnerable plugins (default: 1)
  --dry-run            Preview without loading

Examples:
  # Preview scans with vulnerabilities
  npx tsx scripts/campaign-loader-wordpress.ts --dry-run

  # Load top 50 scans with at least 2 vulnerable plugins
  npx tsx scripts/campaign-loader-wordpress.ts --limit 50 --min-vulns 2
    `);
    process.exit(0);
  }

  let limit = 100;
  let dryRun = false;
  let minVulns = 1;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        limit = parseInt(args[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--min-vulns':
        minVulns = parseInt(args[++i]);
        break;
    }
  }

  try {
    await loadWordPressProspects({ limit, dryRun, minVulns });
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
