#!/usr/bin/env npx tsx

/**
 * GitHub Secrets Campaign Loader
 *
 * Loads prospects from github_secret_leads table.
 * Uses batched Apollo people search to find contacts.
 * Creates campaign contacts with formatted secret_list for email template.
 *
 * Flow:
 * 1. Query HIGH confidence verified leads from github_secret_leads
 * 2. Run batched Apollo people search on extracted domains
 * 3. Enrich contacts for domains with qualified buyers
 * 4. Load into campaign_contacts with campaign_type='github_secrets'
 *
 * Usage:
 *   npm run campaign:loader:github-secrets -- --limit=50
 *   npm run campaign:loader:github-secrets -- --dry-run
 */

import { getPool } from '../lib/database.js';
import { createApolloClientFromEnv, ApolloPerson } from '../apps/campaigns/core/apollo-client.js';
import { isPlaceholderEmail, getRealEmail, escapeHtml } from '../lib/campaigns/email.js';
import { config } from 'dotenv';

config();

const pool = getPool();

interface GitHubSecretLead {
  id: number;
  repo_url: string;
  repo_owner: string;
  repo_name: string;
  secret_type: string;
  secret_preview: string;
  file_path: string;
  confidence_score: number;
  secret_confidence: string;
  extracted_domains: string[];
  extracted_company_name: string | null;
  github_org_website: string | null;
  verified: boolean;
}

async function loadGitHubSecretsProspects(options: {
  limit?: number;
  dryRun?: boolean;
  minConfidence?: string;
}) {
  const { limit = 50, dryRun = false, minConfidence = 'high' } = options;

  console.log('\n🔐 GitHub Secrets Campaign Loader\n');
  console.log(`   Confidence filter: ${minConfidence}`);
  console.log(`   Limit: ${limit}`);
  console.log(`   Dry run: ${dryRun}\n`);

  // Query HIGH confidence verified leads with extracted domains
  const confidenceTiers = minConfidence === 'high' ? ['high'] : ['high', 'medium'];

  const leadsResult = await pool.query(`
    SELECT
      id,
      repo_url,
      repo_owner,
      repo_name,
      secret_type,
      secret_preview,
      file_path,
      confidence_score,
      secret_confidence,
      extracted_domains,
      extracted_company_name,
      github_org_website,
      verified
    FROM github_secret_leads
    WHERE secret_confidence = ANY($1)
      AND verified = true
      AND extracted_domains IS NOT NULL
      AND array_length(extracted_domains, 1) > 0
      AND enrichment_status = 'pending'
    ORDER BY confidence_score DESC
    LIMIT $2
  `, [confidenceTiers, limit]);

  const leads: GitHubSecretLead[] = leadsResult.rows;

  console.log(`📊 Found ${leads.length} qualified GitHub secret leads\n`);

  if (leads.length === 0) {
    console.log('No leads found matching criteria.');
    await pool.end();
    return;
  }

  // Collect ALL extracted domains for each lead (try multiple domains)
  const allDomains = new Set<string>();
  const leadsByDomain = new Map<string, GitHubSecretLead[]>();
  const leadToDomains = new Map<number, string[]>(); // Track all domains per lead

  for (const lead of leads) {
    const leadDomains: string[] = [];

    // Add ALL extracted domains (not just first)
    if (lead.extracted_domains && lead.extracted_domains.length > 0) {
      for (const d of lead.extracted_domains) {
        const normalized = d.toLowerCase();
        leadDomains.push(normalized);
        allDomains.add(normalized);
      }
    }

    // Also add github_org_website if not already in list
    if (lead.github_org_website) {
      try {
        const websiteDomain = new URL(lead.github_org_website).hostname.replace(/^www\./, '').toLowerCase();
        if (!leadDomains.includes(websiteDomain)) {
          leadDomains.push(websiteDomain);
          allDomains.add(websiteDomain);
        }
      } catch {}
    }

    // Map lead to all its domains
    leadToDomains.set(lead.id, leadDomains);

    // Map domains back to leads
    for (const domain of leadDomains) {
      if (!leadsByDomain.has(domain)) {
        leadsByDomain.set(domain, []);
      }
      // Only add if not already associated
      if (!leadsByDomain.get(domain)!.some(l => l.id === lead.id)) {
        leadsByDomain.get(domain)!.push(lead);
      }
    }
  }

  const domains = Array.from(allDomains);
  console.log(`   (${leads.length} leads have avg ${(domains.length / leads.length).toFixed(1)} domains each)`);
  console.log(`🌐 Unique domains to search: ${domains.length}\n`);

  if (dryRun) {
    console.log('DRY RUN - Would search these domains:');
    domains.slice(0, 20).forEach(d => console.log(`   - ${d}`));
    if (domains.length > 20) {
      console.log(`   ... and ${domains.length - 20} more`);
    }

    console.log('\nSample leads:');
    leads.slice(0, 5).forEach(lead => {
      console.log(`   ${lead.repo_owner}/${lead.repo_name}`);
      console.log(`      Secret: ${lead.secret_type}`);
      console.log(`      Domain: ${lead.extracted_domains?.[0] || 'unknown'}`);
      console.log(`      Confidence: ${lead.secret_confidence} (${lead.confidence_score})`);
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
    const domainLeads = leadsByDomain.get(domain) || [];
    if (domainLeads.length === 0) continue;

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

    // Format secret_list for this domain's leads
    // SECURITY: Escape HTML to prevent XSS in email templates
    const secretList = domainLeads.map(lead => {
      const fileName = lead.file_path.split('/').pop() || lead.file_path;
      return `<li><strong>${escapeHtml(lead.secret_type)}:</strong> ${escapeHtml(lead.secret_preview)} (found in ${escapeHtml(fileName)})</li>`;
    }).join('\n');

    const companyName = domainLeads[0].extracted_company_name ||
      contact?.organization?.name ||
      domain;

    // Insert into campaign_contacts + mark leads as enriched (atomic transaction)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        INSERT INTO campaign_contacts (
          id, scan_id, domain, company_name, first_name, last_name,
          full_name, title, email, personal_emails, linkedin_url,
          apollo_person_id, campaign_type, status, enrichment_source,
          metadata
        ) VALUES (
          'contact-gh-' || substr(md5(random()::text || clock_timestamp()::text), 1, 16),
          NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'github_secrets', 'enriched', 'apollo',
          $11
        )
        ON CONFLICT (domain, campaign_type) DO UPDATE SET
          email = EXCLUDED.email,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, [
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
          secret_list: secretList,
          secret_count: domainLeads.length,
          secret_types: Array.from(new Set(domainLeads.map(l => l.secret_type))),
          repo_urls: domainLeads.map(l => l.repo_url),
          github_lead_ids: domainLeads.map(l => l.id)
        })
      ]);

      // Mark leads as enriched
      await client.query(`
        UPDATE github_secret_leads
        SET enrichment_status = 'qualified'
        WHERE id = ANY($1)
      `, [domainLeads.map(l => l.id)]);

      await client.query('COMMIT');

      loaded++;
      console.log(`   ✅ ${companyName} (${domain}) - ${domainLeads.length} secrets`);
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`   ❌ Error loading ${domain}: ${error.message}`);
      skipped++;
    } finally {
      client.release();
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Loading Complete');
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Leads processed: ${leads.length}`);
  console.log(`   Domains searched: ${domains.length}`);
  console.log(`   Contacts found: ${domainsWithContacts.length}`);
  console.log(`   Enrichments: ${enriched}`);
  console.log(`   Loaded: ${loaded}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Show sample
  const sample = await pool.query(`
    SELECT company_name, domain, email, metadata->>'secret_count' as secrets
    FROM campaign_contacts
    WHERE campaign_type = 'github_secrets'
    ORDER BY created_at DESC
    LIMIT 5
  `);

  if (sample.rows.length > 0) {
    console.log('📋 Recent GitHub secrets contacts:');
    sample.rows.forEach((row, i) => {
      console.log(`   ${i + 1}. ${row.company_name} (${row.domain}) - ${row.secrets} secrets - ${row.email}`);
    });
  }

  await pool.end();
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
GitHub Secrets Campaign Loader

Loads GitHub secret leads into campaign_contacts with Apollo enrichment.

Usage:
  npx tsx scripts/campaign-loader-github-secrets.ts [options]

Options:
  --limit <n>          Maximum leads to process (default: 50)
  --min-confidence <t> Minimum confidence tier: high, medium (default: high)
  --dry-run            Preview without loading

Examples:
  # Preview high-confidence leads
  npx tsx scripts/campaign-loader-github-secrets.ts --dry-run

  # Load top 100 leads including medium confidence
  npx tsx scripts/campaign-loader-github-secrets.ts --limit 100 --min-confidence medium
    `);
    process.exit(0);
  }

  let limit = 50;
  let dryRun = false;
  let minConfidence = 'high';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        limit = parseInt(args[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--min-confidence':
        minConfidence = args[++i];
        break;
    }
  }

  try {
    await loadGitHubSecretsProspects({ limit, dryRun, minConfidence });
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
