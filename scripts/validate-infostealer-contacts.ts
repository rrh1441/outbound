#!/usr/bin/env npx tsx

/**
 * Validate Infostealer Contacts
 *
 * Runs email + employment validation on campaign_contacts before outreach.
 * Uses EmailListChecker (email) + Apollo (FREE preview) + Harvest (LinkedIn).
 *
 * Usage:
 *   npm run validate:contacts                    # Validate pending contacts (default limit 100)
 *   npm run validate:contacts -- --limit 500    # Validate up to 500 contacts
 *   npm run validate:contacts -- --domain example.com  # Validate specific domain
 *   npm run validate:contacts -- --dry-run      # Preview without updating DB
 *   npm run validate:contacts -- --status       # Show validation statistics
 *   npm run validate:contacts -- --revalidate   # Re-validate stale contacts
 */

import { config } from 'dotenv';
import { getPool } from '../lib/database.js';
import {
  createValidationServiceFromEnv,
  ValidationResult,
  ContactToValidate,
} from '../lib/campaigns/validation-service.js';
import { createModuleLogger } from '../apps/workers/core/logger.js';

config();

const log = createModuleLogger('validate-contacts');
const pool = getPool();

interface ContactRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  domain: string;
  company_name: string | null;
  linkedin_url: string | null;
  validation_status: string | null;
  validation_score: number | null;
}

interface ValidationStats {
  total: number;
  valid: number;
  stale: number;
  invalid: number;
  pending: number;
}

async function ensureColumnsExist(): Promise<void> {
  // Run the migration to add columns if they don't exist
  await pool.query(`
    ALTER TABLE campaign_contacts
    ADD COLUMN IF NOT EXISTS validation_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS validation_score INTEGER,
    ADD COLUMN IF NOT EXISTS employment_status TEXT,
    ADD COLUMN IF NOT EXISTS employment_verified_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS apollo_current_company TEXT,
    ADD COLUMN IF NOT EXISTS apollo_current_title TEXT,
    ADD COLUMN IF NOT EXISTS harvest_found_at_company BOOLEAN,
    ADD COLUMN IF NOT EXISTS harvest_email_quality_score INTEGER
  `);
  log.info('Validation columns verified');
}

async function getValidationStats(): Promise<ValidationStats> {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN validation_status = 'valid' THEN 1 END) as valid,
      COUNT(CASE WHEN validation_status = 'stale' THEN 1 END) as stale,
      COUNT(CASE WHEN validation_status = 'invalid' THEN 1 END) as invalid,
      COUNT(CASE WHEN validation_status = 'pending' OR validation_status IS NULL THEN 1 END) as pending
    FROM campaign_contacts
    WHERE campaign_type = 'infostealer_credentials'
  `);

  return result.rows[0];
}

async function showStatus(): Promise<void> {
  console.log('\n📊 Infostealer Contact Validation Status\n');

  const stats = await getValidationStats();

  console.log(`   Total contacts: ${stats.total}`);
  console.log(`   ✅ Valid: ${stats.valid} (${((stats.valid / stats.total) * 100).toFixed(1)}%)`);
  console.log(`   ⚠️  Stale: ${stats.stale} (${((stats.stale / stats.total) * 100).toFixed(1)}%)`);
  console.log(`   ❌ Invalid: ${stats.invalid} (${((stats.invalid / stats.total) * 100).toFixed(1)}%)`);
  console.log(`   ⏳ Pending: ${stats.pending} (${((stats.pending / stats.total) * 100).toFixed(1)}%)`);

  // Show score distribution for valid contacts
  const scoreDistribution = await pool.query(`
    SELECT
      CASE
        WHEN validation_score >= 90 THEN '90-100 (High confidence)'
        WHEN validation_score >= 70 THEN '70-89 (Valid)'
        WHEN validation_score >= 40 THEN '40-69 (Stale)'
        ELSE '0-39 (Invalid)'
      END as score_range,
      COUNT(*) as count
    FROM campaign_contacts
    WHERE campaign_type = 'infostealer_credentials'
      AND validation_score IS NOT NULL
    GROUP BY 1
    ORDER BY 1 DESC
  `);

  if (scoreDistribution.rows.length > 0) {
    console.log('\n   Score Distribution:');
    for (const row of scoreDistribution.rows) {
      console.log(`     ${row.score_range}: ${row.count}`);
    }
  }

  // Show employment status breakdown
  const employmentStats = await pool.query(`
    SELECT
      COALESCE(employment_status, 'unknown') as status,
      COUNT(*) as count
    FROM campaign_contacts
    WHERE campaign_type = 'infostealer_credentials'
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  if (employmentStats.rows.length > 0) {
    console.log('\n   Employment Status:');
    for (const row of employmentStats.rows) {
      console.log(`     ${row.status}: ${row.count}`);
    }
  }
}

async function getPendingContacts(limit: number, domain?: string): Promise<ContactRow[]> {
  let query = `
    SELECT
      id, email, first_name, last_name, domain, company_name, linkedin_url,
      validation_status, validation_score
    FROM campaign_contacts
    WHERE campaign_type = 'infostealer_credentials'
      AND (validation_status IS NULL OR validation_status = 'pending')
      AND email IS NOT NULL
  `;

  const params: any[] = [];

  if (domain) {
    params.push(domain);
    query += ` AND domain = $${params.length}`;
  }

  params.push(limit);
  query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const result = await pool.query(query, params);
  return result.rows;
}

async function getStaleContacts(limit: number): Promise<ContactRow[]> {
  const result = await pool.query(
    `
    SELECT
      id, email, first_name, last_name, domain, company_name, linkedin_url,
      validation_status, validation_score
    FROM campaign_contacts
    WHERE campaign_type = 'infostealer_credentials'
      AND validation_status = 'stale'
      AND email IS NOT NULL
    ORDER BY employment_verified_at ASC NULLS FIRST
    LIMIT $1
  `,
    [limit]
  );
  return result.rows;
}

async function updateContactValidation(contactId: string, result: ValidationResult): Promise<void> {
  await pool.query(
    `
    UPDATE campaign_contacts
    SET
      validation_status = $2,
      validation_score = $3,
      employment_status = $4,
      employment_verified_at = $5,
      apollo_current_company = $6,
      apollo_current_title = $7,
      harvest_found_at_company = $8,
      harvest_email_quality_score = $9
    WHERE id = $1
  `,
    [
      contactId,
      result.decision,
      result.score,
      result.employmentStatus,
      result.employmentVerifiedAt,
      result.apolloCurrentCompany,
      result.apolloCurrentTitle,
      result.harvestFoundAtCompany,
      result.harvestEmailQualityScore,
    ]
  );
}

async function archiveInvalidContact(contactId: string, reason: string): Promise<void> {
  // Move to archive table
  await pool.query(
    `
    INSERT INTO campaign_contacts_archive (
      id, scan_id, domain, company_name, first_name, last_name,
      full_name, title, email, personal_emails, linkedin_url,
      apollo_person_id, campaign_type, status, enrichment_source,
      archive_reason, original_created_at
    )
    SELECT
      id, scan_id, domain, company_name, first_name, last_name,
      full_name, title, email, personal_emails, linkedin_url,
      apollo_person_id, campaign_type, status, enrichment_source,
      $2, created_at
    FROM campaign_contacts
    WHERE id = $1
    ON CONFLICT (id) DO NOTHING
  `,
    [contactId, reason]
  );

  // Delete from main table
  await pool.query('DELETE FROM campaign_contacts WHERE id = $1', [contactId]);
}

async function validateContacts(options: {
  limit: number;
  domain?: string;
  dryRun: boolean;
  revalidate: boolean;
}): Promise<void> {
  console.log('\n🔍 Validating Infostealer Contacts\n');

  if (options.dryRun) {
    console.log('   ⚠️  DRY RUN - No database updates will be made\n');
  }

  // Ensure columns exist
  await ensureColumnsExist();

  // Get contacts to validate
  const contacts = options.revalidate
    ? await getStaleContacts(options.limit)
    : await getPendingContacts(options.limit, options.domain);

  if (contacts.length === 0) {
    console.log('   ✅ No contacts to validate');
    return;
  }

  console.log(`   Found ${contacts.length} contacts to validate\n`);

  // Create validation service
  const validationService = createValidationServiceFromEnv();

  // Track results
  let valid = 0;
  let stale = 0;
  let invalid = 0;
  let errors = 0;

  // Process each contact
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const progress = `[${i + 1}/${contacts.length}]`;

    try {
      const contactToValidate: ContactToValidate = {
        email: contact.email,
        firstName: contact.first_name || '',
        lastName: contact.last_name || '',
        targetDomain: contact.domain,
        targetCompany: contact.company_name || undefined,
        linkedinUrl: contact.linkedin_url || undefined,
      };

      const result = await validationService.validateContact(contactToValidate);

      // Log result
      const statusEmoji =
        result.decision === 'valid' ? '✅' : result.decision === 'stale' ? '⚠️' : '❌';

      console.log(
        `   ${progress} ${statusEmoji} ${contact.email} (score: ${result.score}, ${result.decision})`
      );

      if (result.reasons.length > 0) {
        console.log(`           ${result.reasons.join(', ')}`);
      }

      // Update database (unless dry run)
      if (!options.dryRun) {
        await updateContactValidation(contact.id, result);

        // Archive invalid contacts
        if (result.decision === 'invalid') {
          await archiveInvalidContact(contact.id, result.reasons.join('; '));
        }
      }

      // Track stats
      if (result.decision === 'valid') valid++;
      else if (result.decision === 'stale') stale++;
      else invalid++;

      // Rate limiting: ~500ms between validations
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      console.log(`   ${progress} ❓ ${contact.email} - Error: ${error.message}`);
      errors++;
    }
  }

  // Summary
  console.log('\n📊 Validation Summary\n');
  console.log(`   Total processed: ${contacts.length}`);
  console.log(`   ✅ Valid: ${valid}`);
  console.log(`   ⚠️  Stale: ${stale}`);
  console.log(`   ❌ Invalid: ${invalid}`);
  if (errors > 0) {
    console.log(`   ❓ Errors: ${errors}`);
  }

  if (options.dryRun) {
    console.log('\n   (Dry run - no changes made)');
  } else {
    console.log(`\n   ${invalid} contacts archived, ${valid + stale} contacts updated`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const showStatusOnly = args.includes('--status');
  const dryRun = args.includes('--dry-run');
  const revalidate = args.includes('--revalidate');

  let limit = 100;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  let domain: string | undefined;
  const domainIdx = args.indexOf('--domain');
  if (domainIdx >= 0 && args[domainIdx + 1]) {
    domain = args[domainIdx + 1];
  }

  try {
    if (showStatusOnly) {
      await showStatus();
    } else {
      await validateContacts({ limit, domain, dryRun, revalidate });
    }
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
