/**
 * Validate infostealer-exposed emails via Apollo
 *
 * Checks if exposed employees are still at their companies.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { getPool } from '../lib/database.js';
import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { createModuleLogger } from '../lib/logger.js';

const log = createModuleLogger('validate-infostealer');

const DOMAINS_TO_CHECK = [
  'c2perform.com',
  'marrtraffic.com',
  'ostendio.com',
  'renewsolarsolutions.com',
  'thetrainingcenter.com',
  'valleymedical.com'
];

interface ExposedEmail {
  email: string;
  domain: string;
  hasPassword: boolean;
  hasCookies: boolean;
  hasAutofill: boolean;
  hasBrowserData: boolean;
  isInfostealer: boolean;  // TRUE infostealer = has cookies/autofill/browser data
}

async function extractExposedEmails(pool: any): Promise<ExposedEmail[]> {
  const result = await pool.query(`
    SELECT
      s.domain,
      a.metadata
    FROM artifacts a
    JOIN scans s ON a.scan_id = s.id
    WHERE s.domain = ANY($1)
      AND a.type = 'breach_directory_summary'
      AND a.metadata->'breach_analysis'->'leakcheck_results' IS NOT NULL
  `, [DOMAINS_TO_CHECK]);

  const emails: ExposedEmail[] = [];
  const seen = new Set<string>();

  for (const row of result.rows) {
    const domain = row.domain;
    const leakcheckResults = row.metadata?.breach_analysis?.leakcheck_results || [];

    for (const entry of leakcheckResults) {
      // Infostealer = source is "Stealer Logs" (LeakCheck doesn't expose cookie data)
      const sourceName = (entry.source?.name || '').toLowerCase();
      const isInfostealer = sourceName === 'stealer logs' || sourceName.includes('stealer');

      if (entry.email && isInfostealer && seen.has(entry.email) === false) {
        seen.add(entry.email);
        emails.push({
          email: entry.email,
          domain,
          hasPassword: entry.has_password || false,
          hasCookies: entry.has_cookies || false,
          hasAutofill: entry.has_autofill || false,
          hasBrowserData: entry.has_browser_data || false,
          isInfostealer,
        });
      }
    }
  }

  return emails;
}

async function main() {
  const pool = getPool();
  const apolloClient = createApolloClientFromEnv();

  console.log('\n=== Extracting exposed emails ===\n');

  const exposedEmails = await extractExposedEmails(pool);

  if (exposedEmails.length === 0) {
    console.log('No infostealer findings found (source: Stealer Logs).');
    await pool.end();
    return;
  }

  console.log(`Found ${exposedEmails.length} infostealer exposures (source: Stealer Logs):\n`);
  for (const e of exposedEmails) {
    console.log(`  ${e.email}`);
  }

  console.log('\n=== Validating via Apollo ===\n');

  const results: Array<{
    email: string;
    domain: string;
    status: 'STILL_EMPLOYED' | 'LEFT_COMPANY' | 'NOT_FOUND';
    currentCompany?: string;
    currentTitle?: string;
  }> = [];

  for (const exposed of exposedEmails) {
    try {
      // Use Apollo People Enrichment to look up by email
      const enriched = await apolloClient.enrichPerson({
        email: exposed.email,
      });

      if (enriched && enriched.organization) {
        const currentDomain = enriched.organization.primary_domain ||
          enriched.organization.website_url?.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

        const targetDomain = exposed.domain.toLowerCase();
        const isStillEmployed = currentDomain?.toLowerCase() === targetDomain;

        results.push({
          email: exposed.email,
          domain: exposed.domain,
          status: isStillEmployed ? 'STILL_EMPLOYED' : 'LEFT_COMPANY',
          currentCompany: enriched.organization.name,
          currentTitle: enriched.title,
        });

        const statusEmoji = isStillEmployed ? '✅' : '❌';
        console.log(`${statusEmoji} ${exposed.email}`);
        console.log(`   Current: ${enriched.title || 'Unknown'} at ${enriched.organization.name}`);
        if (!isStillEmployed) {
          console.log(`   (Was at: ${exposed.domain})`);
        }
      } else {
        results.push({
          email: exposed.email,
          domain: exposed.domain,
          status: 'NOT_FOUND',
        });
        console.log(`⚠️  ${exposed.email} - Not found in Apollo`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    } catch (error: any) {
      console.log(`❌ ${exposed.email} - Error: ${error.message}`);
      results.push({
        email: exposed.email,
        domain: exposed.domain,
        status: 'NOT_FOUND',
      });
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===\n');

  const stillEmployed = results.filter(r => r.status === 'STILL_EMPLOYED');
  const leftCompany = results.filter(r => r.status === 'LEFT_COMPANY');
  const notFound = results.filter(r => r.status === 'NOT_FOUND');

  console.log(`Still employed: ${stillEmployed.length}`);
  for (const r of stillEmployed) {
    console.log(`  ✅ ${r.email} - ${r.currentTitle} at ${r.currentCompany}`);
  }

  console.log(`\nLeft company: ${leftCompany.length}`);
  for (const r of leftCompany) {
    console.log(`  ❌ ${r.email} - Now at ${r.currentCompany}`);
  }

  console.log(`\nNot found in Apollo: ${notFound.length}`);
  for (const r of notFound) {
    console.log(`  ⚠️  ${r.email}`);
  }

  await pool.end();
}

main().catch(console.error);
