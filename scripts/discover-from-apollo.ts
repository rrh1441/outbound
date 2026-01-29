#!/usr/bin/env npx tsx

/**
 * Apollo-Based Company Discovery with State Tracking
 *
 * Purpose: Pull SMB companies from Apollo, tracking progress to avoid duplicates
 *
 * Cost:
 *   - Company search: 1 credit per page (100 companies)
 *   - People search: MOVED to verify:emails step (separate 1 credit per 100)
 *   - Total: 1 credit per 100 companies in THIS script
 *
 * Usage:
 *   npm run discover:apollo -- --limit=1000
 *   npm run discover:apollo -- --state=Texas --limit=500
 *   npm run discover:apollo -- --employees=1,10 --limit=500
 *   npm run discover:apollo -- --status    # Show progress
 *   npm run discover:apollo -- --dry-run
 *
 * The script tracks progress in apollo_discovery_progress table to avoid
 * re-pulling the same segments.
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import { getPool } from '../lib/database.js';

dotenv.config();

const db = getPool();

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const PER_PAGE = 100;
const MAX_PAGES = 500; // Apollo's pagination limit

if (!APOLLO_API_KEY) {
  console.error('ERROR: APOLLO_API_KEY not found in .env');
  process.exit(1);
}

// Employee ranges (your exact categories)
const EMPLOYEE_RANGES = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500'];

// US States ordered by rough business density (hit the big ones first)
const US_STATES = [
  'California', 'Texas', 'Florida', 'New York', 'Illinois', 'Pennsylvania',
  'Ohio', 'Georgia', 'North Carolina', 'Michigan', 'New Jersey', 'Virginia',
  'Washington', 'Arizona', 'Massachusetts', 'Tennessee', 'Indiana', 'Missouri',
  'Maryland', 'Wisconsin', 'Colorado', 'Minnesota', 'South Carolina', 'Alabama',
  'Louisiana', 'Kentucky', 'Oregon', 'Oklahoma', 'Connecticut', 'Utah',
  'Iowa', 'Nevada', 'Arkansas', 'Mississippi', 'Kansas', 'New Mexico',
  'Nebraska', 'Idaho', 'West Virginia', 'Hawaii', 'New Hampshire', 'Maine',
  'Montana', 'Rhode Island', 'Delaware', 'South Dakota', 'North Dakota',
  'Alaska', 'Vermont', 'Wyoming'
];

// Keywords to exclude - passed to Apollo API organization_not_keywords
const EXCLUDE_KEYWORDS = [
  // Education/Gov/Nonprofit
  'education', 'nonprofit', 'government', 'military', 'political',
  // Media/Entertainment
  'newspapers', 'publishing', 'media production', 'broadcast media',
  'online media', 'entertainment', 'music', 'motion pictures',
  // Cybersecurity competitors (keyword-based)
  'cybersecurity', 'cyber security', 'information security', 'infosec',
  'network security', 'computer security', 'data security',
  'security software', 'security services', 'managed security',
  'penetration testing', 'vulnerability', 'threat intelligence',
  'security consulting', 'identity management', 'access management',
  'siem', 'soc', 'endpoint protection', 'firewall', 'antivirus',
  'threat detection', 'incident response', 'bug bounty', 'red team',
  'blue team', 'zero trust', 'devsecops'
];

// Industries to exclude - passed to Apollo API organization_industries_not
// This filters by the industry FIELD, not just keywords in description
const EXCLUDE_INDUSTRIES = [
  'computer & network security',
  'information security',
  'network security',
  'cyber security',
  'defense & space',
  'military',
  'government administration',
  'government relations',
  'legislative office',
  'political organization',
  'public policy',
  'nonprofit organization management',
  'philanthropy',
  'religious institutions',
  'civic & social organization',
  'primary/secondary education',
  'higher education',
  'education management',
  'e-learning',
  'online media',
  'broadcast media',
  'media production',
  'newspapers',
  'publishing',
  'motion pictures and film',
  'music',
  'entertainment',
  'gambling & casinos'
];

// NOTE: QUALIFIED_TITLES moved to verify-emails-for-scans.ts
// People/title filtering happens in the verify:emails step

interface ApolloOrg {
  id: string;
  name: string;
  primary_domain: string | null;
  website_url: string | null;
  estimated_num_employees: number | null;
  industry: string | null;
  city: string | null;
  state: string | null;
}

interface SegmentProgress {
  state: string;
  employee_range: string;
  total_available: number;
  pages_fetched: number;
  companies_saved: number;
  completed_at: Date | null;
}

// NOTE: batchCheckQualifiedBuyers moved to verify-emails-for-scans.ts
// People search is now a separate step (verify:emails) to avoid duplicate credit spend

async function searchApolloOrgs(
  page: number,
  state: string,
  employeeRange: string
): Promise<{ orgs: ApolloOrg[]; totalPages: number; totalEntries: number }> {
  const response = await axios.post(
    'https://api.apollo.io/api/v1/mixed_companies/search',
    {
      per_page: PER_PAGE,
      page: page,
      organization_locations: [state],
      organization_num_employees_ranges: [employeeRange],
      revenue_range: { min: '1000000', max: '10000000' },
      organization_trading_statuses: ['private'],
      organization_not_keywords: EXCLUDE_KEYWORDS,
      organization_industries_not: EXCLUDE_INDUSTRIES,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
      },
      timeout: 30000,
    }
  );

  return {
    orgs: response.data.organizations || [],
    totalPages: response.data.pagination?.total_pages || 0,
    totalEntries: response.data.pagination?.total_entries || 0,
  };
}

function isValidDomain(domain: string | null): boolean {
  if (!domain) return false;
  if (domain.length < 4) return false;
  if (!domain.includes('.')) return false;
  if (domain.match(/\.(gov|edu|mil)$/i)) return false;
  return true;
}

// Post-fetch industry filter - exact match only (Apollo API does broad filtering)
// This catches cases where Apollo's filtering missed an exact industry match
function isExcludedIndustry(industry: string | null): boolean {
  if (!industry) return false;
  const lowerIndustry = industry.toLowerCase().trim();

  // Only exact matches - Apollo handles broad keyword filtering
  const exactExclusions = [
    'computer & network security',
    'information security',
    'cyber security',
    'defense & space',
    'military'
  ];

  return exactExclusions.includes(lowerIndustry);
}

async function getSegmentProgress(state: string, employeeRange: string): Promise<SegmentProgress | null> {
  const result = await db.query(
    'SELECT * FROM apollo_discovery_progress WHERE state = $1 AND employee_range = $2',
    [state, employeeRange]
  );
  return result.rows[0] || null;
}

async function updateSegmentProgress(
  state: string,
  employeeRange: string,
  totalAvailable: number,
  pagesFetched: number,
  companiesSaved: number,
  completed: boolean
): Promise<void> {
  await db.query(
    `INSERT INTO apollo_discovery_progress
     (state, employee_range, total_available, pages_fetched, companies_saved, completed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (state, employee_range)
     DO UPDATE SET
       total_available = $3,
       pages_fetched = $4,
       companies_saved = $5,
       completed_at = COALESCE(apollo_discovery_progress.completed_at, $6),
       updated_at = NOW()`,
    [state, employeeRange, totalAvailable, pagesFetched, companiesSaved, completed ? new Date() : null]
  );
}

async function insertLeadSource(domain: string, org: ApolloOrg, batch: string): Promise<boolean> {
  try {
    const result = await db.query(
      `INSERT INTO lead_sources (
        source_type, domain, query_template, query_params,
        experiment_batch, campaign_status, discovered_at
      ) VALUES ($1, $2, $3, $4, $5, 'discovered', NOW())
      ON CONFLICT (domain) DO NOTHING
      RETURNING id`,
      [
        'apollo_search',
        domain,
        'apollo_mixed_companies_search',
        JSON.stringify({
          apollo_id: org.id,
          company_name: org.name,
          employees: org.estimated_num_employees,
          industry: org.industry,
          city: org.city,
          state: org.state,
        }),
        batch,
      ]
    );
    return result.rowCount! > 0;
  } catch (error: any) {
    if (!error.message?.includes('duplicate')) {
      console.error(`  Error inserting ${domain}:`, error.message);
    }
    return false;
  }
}

async function showStatus(): Promise<void> {
  console.log('\n📊 Apollo Discovery Progress\n');

  // Overall stats
  const overallResult = await db.query(`
    SELECT
      COUNT(*) as total_segments,
      COUNT(completed_at) as completed_segments,
      SUM(pages_fetched) as total_pages,
      SUM(companies_saved) as total_saved,
      SUM(total_available) as total_available
    FROM apollo_discovery_progress
  `);
  const overall = overallResult.rows[0];

  console.log('Overall:');
  console.log(`  Segments completed: ${overall.completed_segments || 0}/${overall.total_segments || 0}`);
  console.log(`  Pages fetched: ${(overall.total_pages || 0).toLocaleString()}`);
  console.log(`  Companies saved: ${(overall.total_saved || 0).toLocaleString()}`);
  console.log(`  Credits used: ~${overall.total_pages || 0}`);

  // By state
  const stateResult = await db.query(`
    SELECT
      state,
      COUNT(*) as segments,
      COUNT(completed_at) as completed,
      SUM(companies_saved) as saved
    FROM apollo_discovery_progress
    GROUP BY state
    ORDER BY SUM(companies_saved) DESC
    LIMIT 10
  `);

  if (stateResult.rows.length > 0) {
    console.log('\nTop states by companies saved:');
    for (const row of stateResult.rows) {
      console.log(`  ${row.state}: ${row.saved?.toLocaleString() || 0} saved (${row.completed}/${row.segments} segments)`);
    }
  }

  // Next segments to pull
  const nextResult = await db.query(`
    WITH all_segments AS (
      SELECT s.state, e.emp_range
      FROM unnest($1::text[]) s(state)
      CROSS JOIN unnest($2::text[]) e(emp_range)
    )
    SELECT a.state, a.emp_range
    FROM all_segments a
    LEFT JOIN apollo_discovery_progress p
      ON p.state = a.state AND p.employee_range = a.emp_range
    WHERE p.completed_at IS NULL
    LIMIT 5
  `, [US_STATES, EMPLOYEE_RANGES]);

  if (nextResult.rows.length > 0) {
    console.log('\nNext segments to pull:');
    for (const row of nextResult.rows) {
      console.log(`  ${row.state} - ${row.emp_range} employees`);
    }
  }

  console.log();
}

async function discoverSegment(
  state: string,
  employeeRange: string,
  limit: number,
  batch: string,
  dryRun: boolean
): Promise<{ saved: number; processed: number; pagesFetched: number }> {
  // Check existing progress
  const progress = await getSegmentProgress(state, employeeRange);

  if (progress?.completed_at) {
    console.log(`  ⏭️  Already completed (${progress.companies_saved} saved)`);
    return { saved: 0, processed: 0, pagesFetched: 0 };
  }

  const startPage = (progress?.pages_fetched || 0) + 1;

  // Get total count
  const initial = await searchApolloOrgs(1, state, employeeRange);
  const maxPages = Math.min(Math.ceil(initial.totalEntries / PER_PAGE), MAX_PAGES);

  if (initial.totalEntries === 0) {
    await updateSegmentProgress(state, employeeRange, 0, 0, 0, true);
    console.log(`  ⏭️  No companies in this segment`);
    return { saved: 0, processed: 0, pagesFetched: 0 };
  }

  console.log(`  📊 ${initial.totalEntries.toLocaleString()} companies, ${maxPages} pages (starting at page ${startPage})`);

  if (dryRun) {
    return { saved: 0, processed: 0, pagesFetched: 0 };
  }

  let totalProcessed = 0;
  let totalSaved = progress?.companies_saved || 0;
  let pagesFetched = progress?.pages_fetched || 0;
  let skippedNoDomain = 0;

  // 1 page = 100 companies = 1 credit (Apollo filters at API level)
  const pagesForLimit = Math.ceil(limit / PER_PAGE);
  const endPage = Math.min(startPage + pagesForLimit - 1, maxPages);

  for (let page = startPage; page <= endPage; page++) {
    process.stdout.write(`\r    Page ${page}/${maxPages} - ${totalSaved} saved...`);

    try {
      // Reuse initial results for page 1 to avoid double-fetching
      const result = (page === 1) ? initial : await searchApolloOrgs(page, state, employeeRange);

      // Step 1: Collect all valid orgs from this page
      const validOrgs: { domain: string; org: ApolloOrg }[] = [];

      for (const org of result.orgs) {
        totalProcessed++;

        let domain = org.primary_domain || org.website_url;
        if (domain?.startsWith('http')) {
          try { domain = new URL(domain).hostname; } catch {}
        }
        if (domain) {
          domain = domain.toLowerCase().replace(/^www\./, '');
        }

        if (!isValidDomain(domain)) {
          skippedNoDomain++;
          continue;
        }

        // Backup post-fetch industry filter
        if (isExcludedIndustry(org.industry)) {
          continue;
        }

        validOrgs.push({ domain: domain!, org });
      }

      // Step 2: Save all valid domains (people search moved to verify:emails step)
      for (const { domain, org } of validOrgs) {
        const saved = await insertLeadSource(domain, org, batch);
        if (saved) {
          totalSaved++;
        }

        if (totalSaved >= limit) break;
      }

      pagesFetched = page;

      // Save progress after each page
      const completed = page >= maxPages;
      await updateSegmentProgress(state, employeeRange, initial.totalEntries, pagesFetched, totalSaved, completed);

      if (totalSaved >= limit) break;
      await new Promise(r => setTimeout(r, 200));

    } catch (error: any) {
      console.error(`\n    Error on page ${page}:`, error.message);
      if (error.response?.status === 422) {
        // Hit pagination limit, mark as completed
        await updateSegmentProgress(state, employeeRange, initial.totalEntries, pagesFetched, totalSaved, true);
        break;
      }
    }
  }

  // Mark completed if we fetched all pages
  if (pagesFetched >= maxPages) {
    await updateSegmentProgress(state, employeeRange, initial.totalEntries, pagesFetched, totalSaved, true);
  }

  const pagesThisRun = pagesFetched - startPage + 1;
  console.log(`\r    ✅ ${totalSaved} saved, ${pagesThisRun} pages (${pagesThisRun} credits)`);

  return {
    saved: totalSaved - (progress?.companies_saved || 0),
    processed: totalProcessed,
    pagesFetched: pagesThisRun,
  };
}

// Get/update broad search progress
async function getBroadSearchProgress(): Promise<number> {
  const result = await db.query(`
    SELECT pages_fetched FROM apollo_discovery_progress
    WHERE state = 'BROAD' AND employee_range = 'ALL'
  `);
  return result.rows[0]?.pages_fetched || 0;
}

async function updateBroadSearchProgress(pagesFetched: number, companiesSaved: number): Promise<void> {
  await db.query(`
    INSERT INTO apollo_discovery_progress (state, employee_range, total_available, pages_fetched, companies_saved)
    VALUES ('BROAD', 'ALL', 0, $1, $2)
    ON CONFLICT (state, employee_range) DO UPDATE SET
      pages_fetched = apollo_discovery_progress.pages_fetched + $1,
      companies_saved = apollo_discovery_progress.companies_saved + $2,
      updated_at = NOW()
  `, [pagesFetched, companiesSaved]);
}

// Simple broad search - 1 API call per 100 companies (no segment iteration)
async function discoverBroad(
  limit: number,
  batch: string,
  dryRun: boolean
): Promise<{ saved: number; pagesFetched: number }> {
  const pagesNeeded = Math.ceil(limit / PER_PAGE);
  let totalSaved = 0;
  let pagesFetched = 0;

  // Resume from last page
  const startPage = (await getBroadSearchProgress()) + 1;
  const endPage = startPage + pagesNeeded - 1;

  console.log(`📊 Fetching pages ${startPage}-${endPage} (${pagesNeeded} page(s) = ${pagesNeeded} credit(s))\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - No API calls');
    return { saved: 0, pagesFetched: 0 };
  }

  for (let page = startPage; page <= endPage && totalSaved < limit; page++) {
    process.stdout.write(`   Page ${page}...`);

    try {
      // Broad search: US companies, SMB size, exclude competitors
      const response = await axios.post('https://api.apollo.io/v1/organizations/search', {
        page,
        per_page: PER_PAGE,
        organization_locations: ['United States'],
        organization_num_employees_ranges: ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500'],
        organization_not_keywords: EXCLUDE_KEYWORDS,
        organization_industries_not: EXCLUDE_INDUSTRIES,
      }, {
        headers: { 'X-Api-Key': APOLLO_API_KEY }
      });

      const orgs = response.data.organizations || [];

      for (const org of orgs) {
        if (totalSaved >= limit) break;

        let domain = org.primary_domain || org.website_url;
        if (domain?.startsWith('http')) {
          try { domain = new URL(domain).hostname; } catch {}
        }
        if (domain) {
          domain = domain.toLowerCase().replace(/^www\./, '');
        }

        if (!isValidDomain(domain)) continue;

        // Backup post-fetch industry filter
        if (isExcludedIndustry(org.industry)) continue;

        const saved = await insertLeadSource(domain, org, batch);
        if (saved) totalSaved++;
      }

      pagesFetched++;
      // Save progress after each page
      await updateBroadSearchProgress(1, orgs.length);
      console.log(` ${totalSaved} saved`);
    } catch (error: any) {
      console.log(` ERROR: ${error.response?.data?.error || error.message}`);
      break;
    }
  }

  return { saved: totalSaved, pagesFetched };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    await showStatus();
    await db.end();
    return;
  }

  const limitArg = args.find(a => a.startsWith('--limit='));
  const stateArg = args.find(a => a.startsWith('--state='));
  const employeesArg = args.find(a => a.startsWith('--employees='));
  const dryRun = args.includes('--dry-run');
  const useSegments = args.includes('--segments'); // Old segment-based approach

  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 1000;
  const targetState = stateArg ? stateArg.split('=')[1] : null;
  const targetEmployees = employeesArg ? employeesArg.split('=')[1] : null;
  const batch = `apollo_${new Date().toISOString().split('T')[0]}`;

  console.log('🚀 Apollo Company Discovery');
  console.log(`   Limit: ${limit} companies`);
  console.log(`   Mode: ${useSegments ? 'Segment-based (legacy)' : 'Broad search (1 credit per 100)'}`);
  console.log(`   Batch: ${batch}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log();

  let totalSaved = 0;
  let totalCompanyPages = 0;

  // Use broad search by default (efficient), segment-based only with --segments flag
  if (!useSegments && !targetState && !targetEmployees) {
    const result = await discoverBroad(limit, batch, dryRun);
    totalSaved = result.saved;
    totalCompanyPages = result.pagesFetched;
  } else {
    // Legacy segment-based approach (for targeted searches or --segments flag)
    const statesToProcess = targetState ? [targetState] : US_STATES;
    const employeeRangesToProcess = targetEmployees ? [targetEmployees] : EMPLOYEE_RANGES;

    for (const state of statesToProcess) {
      if (totalSaved >= limit) break;

      for (const empRange of employeeRangesToProcess) {
        if (totalSaved >= limit) break;

        console.log(`\n${state} - ${empRange} employees:`);

        const result = await discoverSegment(
          state,
          empRange,
          limit - totalSaved,
          batch,
          dryRun
        );

        totalSaved += result.saved;
        totalCompanyPages += result.pagesFetched;
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Discovery Results');
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ New companies saved: ${totalSaved}`);
  console.log(`💳 Credits used: ${totalCompanyPages} (company search only)`);
  console.log();
  console.log('Next step: npm run verify:emails -- --limit=100  (1 credit per 100)');
  console.log('Check progress: npm run discover:apollo -- --status');
  console.log(`Submit for scanning: npm run discover:qualify -- --batch=${batch}`);
  console.log(`${'='.repeat(60)}\n`);

  await db.end();
}

main().catch(async (error) => {
  console.error('\n❌ Fatal error:', error);
  await db.end();
  process.exit(1);
});
