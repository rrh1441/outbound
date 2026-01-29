#!/usr/bin/env npx tsx

/**
 * Test Enrichment Script - Small Batch
 *
 * Tests enrichment on a small number of companies to verify:
 * 1. Apollo API is working
 * 2. Contacts are being saved to database
 * 3. Success rate is reasonable
 * 4. No bugs in the enrichment logic
 */

import { createApolloClientFromEnv } from '../apps/campaigns/core/apollo-client.js';
import { findBestRoleEmail } from '../apps/campaigns/core/role-email-finder.js';
import { HarvestClient } from '../apps/campaigns/core/harvest-client.js';
import { getPool } from '../lib/database.js';
import { config } from 'dotenv';

config();

const pool = getPool();

async function main() {
  const batchSize = parseInt(process.argv[2]) || 20;

  console.log(`\n🧪 Test Enrichment - ${batchSize} Companies\n`);

  // Get test batch
  const result = await pool.query(`
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
    WHERE NOT EXISTS (
      SELECT 1 FROM campaign_contacts cc
      WHERE cc.scan_id = ls.id
    )
    ORDER BY
      CASE ls.campaign_type
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'ada_accessibility' THEN 3
        WHEN 'email_security' THEN 4
        ELSE 5
      END,
      ls.domain
    LIMIT $1
  `, [batchSize]);

  const companies = result.rows;
  console.log(`Found ${companies.length} companies to test\n`);

  if (companies.length === 0) {
    console.log('No companies to enrich!');
    await pool.end();
    return;
  }

  // Show breakdown
  const breakdown: Record<string, number> = {};
  companies.forEach(c => {
    breakdown[c.campaign_type] = (breakdown[c.campaign_type] || 0) + 1;
  });
  console.log('Campaign types:');
  Object.entries(breakdown).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  console.log('');

  const apolloClient = createApolloClientFromEnv();
  const harvestClient = process.env.HARVEST_API_KEY
    ? new HarvestClient(process.env.HARVEST_API_KEY)
    : null;

  let successCount = 0;
  let noContactCount = 0;
  let noEmailCount = 0;
  let errorCount = 0;
  let harvestSuccessCount = 0;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    console.log(`\n[${i + 1}/${companies.length}] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 ${company.company_name || company.domain}`);
    console.log(`   Campaign: ${company.campaign_type}`);
    console.log(`   Domain: ${company.domain}`);

    try {
      // Find executive
      const person = await apolloClient.findExecutiveContact(company.domain, true);

      if (!person) {
        console.log(`   ⚠️  No executive found via Apollo`);

        // Try Harvest as fallback (especially for WordPress/SMB companies)
        if (harvestClient && (company.campaign_type === 'wordpress' || company.campaign_type === 'email_security')) {
          console.log(`   🔄 Trying Harvest API...`);

          try {
            // Search for CEO/Owner/Founder at this company
            const searchResults = await harvestClient.searchProfiles({
              currentCompany: company.company_name || company.domain.split('.')[0],
              title: 'CEO OR Owner OR Founder OR President',
              page: 1
            });

            if (searchResults.elements && searchResults.elements.length > 0) {
              const topMatch = searchResults.elements[0];
              console.log(`   🔍 Found LinkedIn profile: ${topMatch.name}`);

              // Skip hidden profiles (LinkedIn Member) - they don't have accessible data
              if (topMatch.hidden || !topMatch.publicIdentifier) {
                console.log(`   ⚠️  Profile is hidden or has no public identifier - skipping`);
                console.log(`   🔄 Trying role-based emails...`);
                const roleEmail = await findBestRoleEmail(company.domain, { verifySmtp: false });
                if (roleEmail) {
                  console.log(`   ✅ Found role email: ${roleEmail.email} (${roleEmail.role})`);
                  // Save role email logic here...
                } else {
                  console.log(`   ⚠️  No contacts found via any method`);
                  noContactCount++;
                }
                if (i < companies.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
                continue;
              }

              // Get full profile with email (costs $0.016 per profile)
              const profileData = await harvestClient.getProfile({
                profileId: topMatch.id,           // Harvest internal ID
                publicIdentifier: topMatch.publicIdentifier,  // LinkedIn public identifier
                findEmail: true,      // COSTS $0.016 per profile
                skipSmtp: false       // Performs SMTP verification
              });

              // Extract best email (same logic as debug)
              let harvestEmail: string | null = null;
              let harvestEmailStatus: string | null = null;

              if (profileData && profileData.emails && profileData.emails.length > 0) {
                const validEmail = profileData.emails.find(e => e.status === 'valid');
                const anyEmail = profileData.emails[0];

                if (validEmail) {
                  harvestEmail = validEmail.email;
                  harvestEmailStatus = validEmail.status;
                } else if (anyEmail) {
                  harvestEmail = anyEmail.email;
                  harvestEmailStatus = anyEmail.status;
                }
              }

              if (harvestEmail) {
                console.log(`   ✅ Harvest enrichment successful (cost: $0.016)`);
                console.log(`   ✅ ${profileData.firstName} ${profileData.lastName} (${profileData.headline || 'Unknown title'})`);
                console.log(`      Email: ${harvestEmail} (status: ${harvestEmailStatus})`);
                console.log(`   💾 Saving to database...`);

                const insertResult = await pool.query(`
                  INSERT INTO campaign_contacts (
                    scan_id, domain, company_name, first_name, last_name,
                    full_name, title, email, linkedin_url, campaign_type,
                    enrichment_source
                  ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'harvest'
                  )
                  RETURNING id
                `, [
                  company.scan_id,
                  company.domain,
                  company.company_name,
                  profileData.firstName,
                  profileData.lastName,
                  `${profileData.firstName} ${profileData.lastName}`,
                  profileData.headline || 'Owner',
                  harvestEmail,  // Use extracted email from emails array
                  profileData.linkedinUrl || `https://www.linkedin.com/in/${topMatch.publicIdentifier}`,
                  company.campaign_type
                ]);

                console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
                successCount++;
                harvestSuccessCount++;

                // Wait before next to respect Harvest rate limits
                if (i < companies.length - 1) {
                  console.log(`   ⏸️  Waiting 3s for Harvest rate limit...`);
                  await new Promise(resolve => setTimeout(resolve, 3000));
                }
                continue;
              } else if (profileData && (!profileData.emails || profileData.emails.length === 0)) {
                console.log(`   ⚠️  Harvest found profile but no email`);
              } else {
                console.log(`   ⚠️  Harvest profile is hidden or unavailable`);
              }
            } else {
              console.log(`   ⚠️  No profiles found via Harvest`);
            }
          } catch (harvestError: any) {
            console.log(`   ⚠️  Harvest error: ${harvestError.message}`);
          }
        }

        // Final fallback: Try role-based emails
        console.log(`   🔄 Trying role-based emails...`);
        const roleEmail = await findBestRoleEmail(company.domain, { verifySmtp: false });

        if (roleEmail) {
          console.log(`   ✅ Found role email: ${roleEmail.email} (${roleEmail.role})`);
          console.log(`   💾 Saving to database...`);

          const insertResult = await pool.query(`
            INSERT INTO campaign_contacts (
              id, scan_id, domain, company_name, first_name, last_name,
              full_name, title, email, personal_emails, linkedin_url,
              apollo_person_id, campaign_type, enrichment_source
            ) VALUES (
              'contact-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
              $1, $2, $3, NULL, NULL, $4, $5, $6, '{}', NULL, NULL, $7, 'role_email'
            )
            RETURNING id
          `, [
            company.scan_id,
            company.domain,
            company.company_name,
            roleEmail.role,
            roleEmail.role,
            roleEmail.email,
            company.campaign_type
          ]);

          console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
          successCount++;
        } else {
          console.log(`   ⚠️  No contacts found via any method`);
          noContactCount++;
        }

        // Wait before next to respect rate limits
        if (i < companies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        continue;
      }

      const email = person.email || (person.personal_emails && person.personal_emails[0]);

      if (!email) {
        console.log(`   ⚠️  Found ${person.name} (${person.title}) but NO EMAIL`);
        noEmailCount++;

        // Wait before next
        if (i < companies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        continue;
      }

      console.log(`   ✅ ${person.name} (${person.title})`);
      console.log(`      Email: ${email}`);

      // Save to database
      console.log(`   💾 Saving to database...`);

      const insertResult = await pool.query(`
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
        RETURNING id
      `, [
        company.scan_id,
        company.domain,
        company.company_name,
        person.first_name,
        person.last_name,
        person.name,
        person.title,
        email,
        person.personal_emails || [],
        person.linkedin_url,
        person.id,
        company.campaign_type
      ]);

      console.log(`   ✅ Saved with ID: ${insertResult.rows[0].id}`);
      successCount++;

    } catch (error: any) {
      console.error(`   ❌ ERROR: ${error.message}`);

      // Check if rate limit
      if (error.message.includes('429') || error.message.includes('rate limit')) {
        console.log('\n⏱️  Rate limit hit! Stopping test.');
        console.log('Wait for rate limit to reset before trying again.');
        break;
      }

      errorCount++;
    }

    // Rate limit protection: 2 seconds between companies
    if (i < companies.length - 1) {
      console.log(`   ⏸️  Waiting 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Summary
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 Test Results');
  console.log('='.repeat(70));
  console.log(`Total processed: ${companies.length}`);
  console.log(`✅ Success (saved to DB): ${successCount} (${Math.round(successCount/companies.length*100)}%)`);
  console.log(`⚠️  No contact found: ${noContactCount}`);
  console.log(`⚠️  Contact but no email: ${noEmailCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log('='.repeat(70));

  // Harvest API usage and cost tracking
  if (harvestSuccessCount > 0) {
    const harvestCost = harvestSuccessCount * 0.016;
    console.log('\n💰 Harvest API Usage:');
    console.log(`   Profiles with email found: ${harvestSuccessCount}`);
    console.log(`   Total cost: $${harvestCost.toFixed(3)}`);
    console.log(`   Remaining budget (5,000 limit): ${5000 - harvestSuccessCount} profiles`);
  }

  // Verify database
  console.log('\n🔍 Verifying database...\n');

  const dbCheck = await pool.query(`
    SELECT
      campaign_type,
      COUNT(*) as count
    FROM campaign_contacts
    GROUP BY campaign_type
    ORDER BY count DESC
  `);

  console.log('Contacts in database:');
  if (dbCheck.rows.length === 0) {
    console.log('  (none)');
  } else {
    dbCheck.rows.forEach(row => {
      console.log(`  ${row.campaign_type}: ${row.count}`);
    });
  }

  const totalCheck = await pool.query('SELECT COUNT(*) as total FROM campaign_contacts');
  console.log(`\nTotal contacts: ${totalCheck.rows[0].total}\n`);

  await pool.end();
}

main().catch(async (error) => {
  console.error('\n❌ Fatal error:', error);
  await pool.end();
  process.exit(1);
});
