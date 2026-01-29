#!/usr/bin/env npx tsx

/**
 * Campaign Enrichment Script
 *
 * Enriches companies with executive contact information from Apollo.io
 * Priority order: WordPress → Infostealer → ADA → Email Security
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

interface EnrichmentOptions {
  campaignType?: string;
  batchSize?: number;
  skipExisting?: boolean;
}

async function getCompaniesToEnrich(options: EnrichmentOptions) {
  const { campaignType, batchSize = 50, skipExisting = true } = options;

  let query = `
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
  `;

  if (skipExisting) {
    query += `
      WHERE NOT EXISTS (
        SELECT 1 FROM campaign_contacts cc
        WHERE cc.scan_id = ls.id
      )
    `;
  } else {
    query += ' WHERE 1=1 ';
  }

  if (campaignType) {
    query += ` AND ls.campaign_type = $1 `;
  }

  // Priority order
  query += `
    ORDER BY
      CASE ls.campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'ada_accessibility' THEN 3
        WHEN 'email_security' THEN 4
        ELSE 5
      END,
      ls.domain
    LIMIT $${campaignType ? '2' : '1'}
  `;

  const params = campaignType ? [campaignType, batchSize] : [batchSize];
  const result = await pool.query(query, params);
  return result.rows;
}

async function enrichCompany(apolloClient: any, company: any) {
  const { scan_id, domain, company_name, campaign_type } = company;

  console.log(`\n🔍 Enriching: ${company_name || domain} (${campaign_type})`);

  try {
    // Find executive contact
    const person = await apolloClient.findExecutiveContact(domain, true);

    if (!person) {
      console.log('  ⚠️  No executive found');
      return { success: false, reason: 'no_contact_found' };
    }

    const email = person.email || (person.personal_emails && person.personal_emails[0]);
    if (!email) {
      console.log('  ⚠️  Contact found but no email');
      return { success: false, reason: 'no_email' };
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
      ON CONFLICT (id) DO NOTHING
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

    return { success: true, person };
  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`);
    return { success: false, reason: error.message };
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let campaignType: string | undefined;
  let batchSize = 50;
  let skipExisting = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--campaign-type' && args[i + 1]) {
      campaignType = args[i + 1];
      i++;
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--all') {
      skipExisting = false;
    } else if (args[i] === '--help') {
      console.log(`
Campaign Enrichment Script

Usage:
  npm run enrich:campaigns [options]

Options:
  --campaign-type <type>   Only enrich specific campaign type
                          (wordpress, infostealer_credentials, ada_accessibility, email_security)
  --batch-size <N>        Number of companies to enrich (default: 50)
  --all                   Re-enrich all companies (including already enriched)
  --help                  Show this help message

Examples:
  # Enrich next 50 companies (WordPress first)
  npm run enrich:campaigns

  # Enrich only WordPress campaigns
  npm run enrich:campaigns -- --campaign-type wordpress --batch-size 100

  # Enrich infostealer campaigns
  npm run enrich:campaigns -- --campaign-type infostealer_credentials

Priority Order:
  1. WordPress (463 companies)
  2. Infostealer Credentials (5,009 companies)
  3. ADA Accessibility (163 companies)
  4. Email Security (3,771 companies)

Rate Limits:
  - Apollo API: 400 calls/hour
  - Each company uses ~2 calls (1 search + 1 enrich)
  - Can process ~200 companies/hour
  - Batch size of 50 = ~100 API calls = safe buffer
      `);
      process.exit(0);
    }
  }

  console.log('🚀 Campaign Enrichment Starting\n');
  console.log(`Campaign Type: ${campaignType || 'All (priority order)'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Skip Existing: ${skipExisting}\n`);

  // Get companies to enrich
  const companies = await getCompaniesToEnrich({ campaignType, batchSize, skipExisting });

  if (companies.length === 0) {
    console.log('✅ No companies to enrich!');
    await pool.end();
    process.exit(0);
  }

  console.log(`📋 Found ${companies.length} companies to enrich\n`);
  console.log('Campaign breakdown:');
  const breakdown: Record<string, number> = {};
  companies.forEach(c => {
    breakdown[c.campaign_type] = (breakdown[c.campaign_type] || 0) + 1;
  });
  Object.entries(breakdown).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  // Initialize Apollo client
  const apolloClient = createApolloClientFromEnv();

  // Enrich companies
  let successCount = 0;
  let failureCount = 0;
  const failures: any[] = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    console.log(`\n[${i + 1}/${companies.length}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const result = await enrichCompany(apolloClient, company);

    if (result.success) {
      successCount++;
    } else {
      failureCount++;
      failures.push({ company, reason: result.reason });
    }

    // Rate limiting: ~1.5 seconds between companies (conservative)
    if (i < companies.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Summary
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`📊 Enrichment Complete\n`);
  console.log(`✅ Success: ${successCount}/${companies.length} (${Math.round(successCount/companies.length*100)}%)`);
  console.log(`❌ Failed: ${failureCount}/${companies.length}\n`);

  if (failures.length > 0 && failures.length <= 10) {
    console.log('Failed companies:');
    failures.forEach(f => {
      console.log(`  ${f.company.domain} - ${f.reason}`);
    });
  }

  // Get overall stats
  const stats = await pool.query(`
    SELECT
      campaign_type,
      COUNT(*) as enriched_count
    FROM campaign_contacts
    GROUP BY campaign_type
    ORDER BY
      CASE campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'ada_accessibility' THEN 3
        WHEN 'email_security' THEN 4
        ELSE 5
      END
  `);

  console.log('\n📈 Overall Enrichment Progress:\n');
  stats.rows.forEach(row => {
    console.log(`  ${row.campaign_type}: ${row.enriched_count} contacts`);
  });

  await pool.end();
}

main().catch(console.error);
