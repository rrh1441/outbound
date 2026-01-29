#!/usr/bin/env npx tsx

/**
 * API Ingest Script
 *
 * Fetches company data from your source API and loads it into campaign_prospects.
 * Adapt the Company interface and API response handling to match your actual API.
 *
 * Usage:
 *   npm run ingest:api                    # Fetch and load all companies
 *   npm run ingest:api -- --dry-run       # Preview without inserting
 *   npm run ingest:api -- --limit 100     # Process max 100 companies
 *
 * Environment variables:
 *   SOURCE_API_URL     - Base URL of your data source API
 *   SOURCE_API_KEY     - API key for authentication (if required)
 *   DATABASE_URL       - PostgreSQL connection string
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();

// === CUSTOMIZE THIS INTERFACE TO MATCH YOUR API ===
interface Company {
  id: string;
  domain: string;
  name: string;
  // Add any other fields your API returns
  // findings?: Array<{ type: string; severity: string; details: any }>;
}

interface ApiResponse {
  companies: Company[];
  // Adjust based on your API response structure
}

// === CUSTOMIZE THIS FUNCTION TO MATCH YOUR API ===
async function fetchCompanies(): Promise<Company[]> {
  const apiUrl = process.env.SOURCE_API_URL;
  const apiKey = process.env.SOURCE_API_KEY;

  if (!apiUrl) {
    throw new Error('SOURCE_API_URL environment variable is required');
  }

  console.log(`Fetching companies from ${apiUrl}...`);

  const response = await fetch(apiUrl, {
    headers: {
      'Authorization': apiKey ? `Bearer ${apiKey}` : '',
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data: ApiResponse = await response.json();
  return data.companies;
}

async function ingestCompanies(options: { dryRun: boolean; limit?: number }) {
  const { dryRun, limit } = options;

  console.log('=== API Ingest ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (limit) console.log(`Limit: ${limit}`);

  // Fetch companies from API
  let companies = await fetchCompanies();
  console.log(`Fetched ${companies.length} companies from API`);

  if (limit && companies.length > limit) {
    companies = companies.slice(0, limit);
    console.log(`Limited to ${limit} companies`);
  }

  // Get or create a campaign for this ingest
  const campaignId = await getOrCreateCampaign();

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const company of companies) {
    try {
      // Check for existing prospect with same source_id
      const existing = await pool.query(
        `SELECT id FROM campaign_prospects WHERE campaign_id = $1 AND source_id = $2`,
        [campaignId, company.id]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`[DRY RUN] Would insert: ${company.domain} (${company.name})`);
        inserted++;
        continue;
      }

      // Generate tracking token for email tracking
      const trackingToken = randomUUID();

      // Insert prospect
      await pool.query(`
        INSERT INTO campaign_prospects (
          campaign_id,
          source_id,
          source_type,
          domain,
          company_name,
          contact_email,
          tracking_token
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        campaignId,
        company.id,
        'api',
        company.domain,
        company.name,
        '', // contact_email will be filled by enrichment
        trackingToken,
      ]);

      inserted++;
      console.log(`Inserted: ${company.domain} (${company.name})`);
    } catch (err) {
      errors++;
      console.error(`Error processing ${company.domain}:`, err);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (duplicates): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Campaign ID: ${campaignId}`);

  if (!dryRun && inserted > 0) {
    console.log('\nNext steps:');
    console.log('1. Run enrichment: npm run enrich:campaigns');
    console.log('2. Verify emails: npm run verify:emails:bulk');
    console.log('3. Send test emails: CAMPAIGN_TEST_MODE=true npm run campaign:send');
  }
}

async function getOrCreateCampaign(): Promise<string> {
  // Look for existing draft campaign or create new one
  const result = await pool.query(`
    SELECT id FROM campaigns
    WHERE status = 'draft' AND campaign_type = 'api_ingest'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (result.rows.length > 0) {
    console.log(`Using existing campaign: ${result.rows[0].id}`);
    return result.rows[0].id;
  }

  // Create new campaign
  const newCampaign = await pool.query(`
    INSERT INTO campaigns (name, campaign_type, status)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [
    `API Ingest ${new Date().toISOString().split('T')[0]}`,
    'api_ingest',
    'draft',
  ]);

  console.log(`Created new campaign: ${newCampaign.rows[0].id}`);
  return newCampaign.rows[0].id;
}

// Parse CLI arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIndex = args.indexOf('--limit');
const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : undefined;

ingestCompanies({ dryRun, limit })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
