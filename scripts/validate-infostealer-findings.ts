#!/usr/bin/env npx tsx

/**
 * Validate Infostealer Findings (GATE 1)
 *
 * Validates exposed employee emails from LeakCheck BEFORE enrichment.
 * Uses Apollo FREE preview to check if employees still at company.
 *
 * IMPORTANT: By default, this script ONLY validates scans that have a valid
 * contact found in infostealer_batch_results (from free batch people search).
 * This prevents wasting credits validating scans with no recipient to contact.
 *
 * Pipeline order:
 *   1. Scan domains → find findings
 *   2. FREE batch people search → find valid recipients (infostealer_batch_results)
 *   3. Validate findings (this script) → ONLY for scans WITH valid recipients
 *   4. Enrich contacts → get email addresses
 *
 * Usage:
 *   npm run validate:findings                    # Validate pending (requires batch search first)
 *   npm run validate:findings -- --limit 100    # Validate up to 100 findings
 *   npm run validate:findings -- --domain example.com  # Validate specific domain
 *   npm run validate:findings -- --dry-run      # Preview without updating DB
 *   npm run validate:findings -- --status       # Show validation statistics
 *   npm run validate:findings -- --revalidate   # Re-validate stale findings
 *   npm run validate:findings -- --skip-batch-check  # DANGEROUS: Skip batch results check
 */

import { config } from 'dotenv';
import { getPool } from '../lib/database.js';
import {
  createValidationServiceFromEnv,
  ExposedEmployee,
  FindingValidationResult,
} from '../lib/campaigns/validation-service.js';
import { createModuleLogger } from '../apps/workers/core/logger.js';

config();

const log = createModuleLogger('validate-findings');
const pool = getPool();

interface ScanRow {
  id: string;
  domain: string;
  finding_validation_status: string | null;
  finding_validation_score: number | null;
  exposed_employees: string[]; // JSON array of emails from stealer logs
}

interface ValidationStats {
  total: number;
  fresh: number;
  stale: number;
  invalid: number;
  pending: number;
}

async function ensureColumnsExist(): Promise<void> {
  // Run the migration to add columns if they don't exist
  await pool.query(`
    ALTER TABLE scans
    ADD COLUMN IF NOT EXISTS finding_validation_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS finding_validation_score INTEGER,
    ADD COLUMN IF NOT EXISTS finding_validated_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS finding_validation_details JSONB
  `);
  log.info('Finding validation columns verified');
}

async function getValidationStats(): Promise<ValidationStats> {
  // Only count scans that have infostealer findings
  const result = await pool.query(`
    WITH infostealer_scans AS (
      SELECT DISTINCT s.id
      FROM scans s
      JOIN artifacts a ON a.scan_id = s.id AND a.type = 'breach_directory_summary'
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') r
        WHERE r->'source'->>'name' = 'Stealer Logs'
      )
    )
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN s.finding_validation_status = 'fresh' THEN 1 END) as fresh,
      COUNT(CASE WHEN s.finding_validation_status = 'stale' THEN 1 END) as stale,
      COUNT(CASE WHEN s.finding_validation_status = 'invalid' THEN 1 END) as invalid,
      COUNT(CASE WHEN s.finding_validation_status = 'pending' OR s.finding_validation_status IS NULL THEN 1 END) as pending
    FROM scans s
    WHERE s.id IN (SELECT id FROM infostealer_scans)
  `);

  return result.rows[0];
}

async function showStatus(): Promise<void> {
  console.log('\n📊 Infostealer Finding Validation Status\n');

  const stats = await getValidationStats();
  const total = parseInt(stats.total) || 0;

  if (total === 0) {
    console.log('   No scans with infostealer findings found.');
    return;
  }

  console.log(`   Total findings: ${total}`);
  console.log(`   ✅ Fresh: ${stats.fresh} (${((stats.fresh / total) * 100).toFixed(1)}%)`);
  console.log(`   ⚠️  Stale: ${stats.stale} (${((stats.stale / total) * 100).toFixed(1)}%)`);
  console.log(`   ❌ Invalid: ${stats.invalid} (${((stats.invalid / total) * 100).toFixed(1)}%)`);
  console.log(`   ⏳ Pending: ${stats.pending} (${((stats.pending / total) * 100).toFixed(1)}%)`);

  // Show score distribution
  const scoreDistribution = await pool.query(`
    WITH infostealer_scans AS (
      SELECT DISTINCT s.id
      FROM scans s
      JOIN artifacts a ON a.scan_id = s.id AND a.type = 'breach_directory_summary'
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') r
        WHERE r->'source'->>'name' = 'Stealer Logs'
      )
    )
    SELECT
      CASE
        WHEN finding_validation_score >= 70 THEN '70-100 (Fresh)'
        WHEN finding_validation_score >= 40 THEN '40-69 (Stale)'
        ELSE '0-39 (Invalid)'
      END as score_range,
      COUNT(*) as count
    FROM scans
    WHERE id IN (SELECT id FROM infostealer_scans)
      AND finding_validation_score IS NOT NULL
    GROUP BY 1
    ORDER BY 1 DESC
  `);

  if (scoreDistribution.rows.length > 0) {
    console.log('\n   Score Distribution:');
    for (const row of scoreDistribution.rows) {
      console.log(`     ${row.score_range}: ${row.count}`);
    }
  }

  // Show recent validations
  const recentValidations = await pool.query(`
    SELECT domain, finding_validation_status, finding_validation_score, finding_validated_at
    FROM scans
    WHERE finding_validation_status IS NOT NULL
      AND finding_validation_status != 'pending'
    ORDER BY finding_validated_at DESC
    LIMIT 5
  `);

  if (recentValidations.rows.length > 0) {
    console.log('\n   Recent Validations:');
    for (const row of recentValidations.rows) {
      const emoji =
        row.finding_validation_status === 'fresh'
          ? '✅'
          : row.finding_validation_status === 'stale'
          ? '⚠️'
          : '❌';
      console.log(
        `     ${emoji} ${row.domain} (score: ${row.finding_validation_score})`
      );
    }
  }
}

async function getPendingFindings(limit: number, domain?: string, skipBatchCheck?: boolean): Promise<ScanRow[]> {
  // Get scans with infostealer findings that haven't been validated
  // IMPORTANT: By default, only include scans that have a valid contact in infostealer_batch_results
  // This prevents wasting credits on scans with no recipient to contact
  let query = `
    WITH exposed_employees AS (
      SELECT
        s.id as scan_id,
        s.domain,
        s.finding_validation_status,
        s.finding_validation_score,
        jsonb_agg(DISTINCT r->>'email') as emails
      FROM scans s
      JOIN artifacts a ON a.scan_id = s.id AND a.type = 'breach_directory_summary'
      CROSS JOIN LATERAL jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') as r
      WHERE r->'source'->>'name' = 'Stealer Logs'
        AND s.status = 'completed'
        AND (s.finding_validation_status IS NULL OR s.finding_validation_status = 'pending')
  `;

  const params: any[] = [];

  if (domain) {
    params.push(domain);
    query += ` AND REPLACE(s.domain, 'www.', '') = REPLACE($${params.length}, 'www.', '')`;
  }

  // DEFAULT: Only include scans that have a valid contact from FREE batch search
  // This is the critical gate that prevents wasting credits
  if (!skipBatchCheck) {
    query += `
        AND EXISTS (
          SELECT 1 FROM infostealer_batch_results ibr
          WHERE REPLACE(ibr.domain, 'www.', '') = REPLACE(s.domain, 'www.', '')
            AND ibr.person_data IS NOT NULL
        )`;
  }

  query += `
      GROUP BY s.id, s.domain, s.finding_validation_status, s.finding_validation_score
    )
    SELECT
      scan_id as id,
      domain,
      finding_validation_status,
      finding_validation_score,
      emails as exposed_employees
    FROM exposed_employees
  `;

  params.push(limit);
  query += ` ORDER BY domain LIMIT $${params.length}`;

  const result = await pool.query(query, params);
  return result.rows;
}

async function getStaleFindings(limit: number): Promise<ScanRow[]> {
  const result = await pool.query(
    `
    WITH exposed_employees AS (
      SELECT
        s.id as scan_id,
        s.domain,
        s.finding_validation_status,
        s.finding_validation_score,
        jsonb_agg(DISTINCT r->>'email') as emails
      FROM scans s
      JOIN artifacts a ON a.scan_id = s.id AND a.type = 'breach_directory_summary'
      CROSS JOIN LATERAL jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') as r
      WHERE r->'source'->>'name' = 'Stealer Logs'
        AND s.status = 'completed'
        AND s.finding_validation_status = 'stale'
      GROUP BY s.id, s.domain, s.finding_validation_status, s.finding_validation_score
    )
    SELECT
      scan_id as id,
      domain,
      finding_validation_status,
      finding_validation_score,
      emails as exposed_employees
    FROM exposed_employees
    ORDER BY finding_validated_at ASC NULLS FIRST
    LIMIT $1
  `,
    [limit]
  );
  return result.rows;
}

async function updateFindingValidation(
  scanId: string,
  result: FindingValidationResult
): Promise<void> {
  await pool.query(
    `
    UPDATE scans
    SET
      finding_validation_status = $2,
      finding_validation_score = $3,
      finding_validated_at = $4,
      finding_validation_details = $5
    WHERE id = $1
  `,
    [
      scanId,
      result.decision,
      result.score,
      result.validatedAt,
      JSON.stringify({
        employees_checked: result.employeesChecked,
        employees_confirmed: result.employeesConfirmed,
        employees_left: result.employeesLeft,
        employees_unknown: result.employeesUnknown,
        emails_valid: result.emailsValid,
        emails_invalid: result.emailsInvalid,
        reasons: result.reasons,
      }),
    ]
  );
}

async function validateFindings(options: {
  limit: number;
  domain?: string;
  dryRun: boolean;
  revalidate: boolean;
  skipBatchCheck: boolean;
}): Promise<void> {
  console.log('\n🔍 Validating Infostealer Findings (GATE 1)\n');

  if (options.dryRun) {
    console.log('   ⚠️  DRY RUN - No database updates will be made\n');
  }

  if (options.skipBatchCheck) {
    console.log('   ⚠️  WARNING: Skipping batch check - validating ALL findings!\n');
    console.log('   ⚠️  This may waste credits on scans without valid recipients.\n');
  } else {
    console.log('   ✅ Only validating findings with valid contacts from batch search\n');
  }

  // Ensure columns exist
  await ensureColumnsExist();

  // Get findings to validate
  const findings = options.revalidate
    ? await getStaleFindings(options.limit)
    : await getPendingFindings(options.limit, options.domain, options.skipBatchCheck);

  if (findings.length === 0) {
    console.log('   ✅ No findings to validate');
    return;
  }

  console.log(`   Found ${findings.length} findings to validate\n`);

  // Show sample
  console.log('   Sample findings:');
  for (const finding of findings.slice(0, 3)) {
    const emails =
      typeof finding.exposed_employees === 'string'
        ? JSON.parse(finding.exposed_employees)
        : finding.exposed_employees;
    console.log(`     - ${finding.domain}: ${emails.length} exposed employees`);
  }
  console.log('');

  // Create validation service
  const validationService = createValidationServiceFromEnv();

  // Track results
  let fresh = 0;
  let stale = 0;
  let invalid = 0;
  let errors = 0;

  // Process each finding
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const progress = `[${i + 1}/${findings.length}]`;

    try {
      // Parse exposed employee emails
      const emails: string[] =
        typeof finding.exposed_employees === 'string'
          ? JSON.parse(finding.exposed_employees)
          : finding.exposed_employees;

      // Convert to ExposedEmployee format
      const exposedEmployees: ExposedEmployee[] = emails
        .filter((email) => email && email.includes('@'))
        .map((email) => ({ email }));

      if (exposedEmployees.length === 0) {
        console.log(`   ${progress} ⏭️  ${finding.domain} - No valid emails to check`);
        continue;
      }

      // Run validation
      const result = await validationService.validateFindings(
        finding.domain,
        exposedEmployees,
        5 // Check up to 5 employees
      );

      // Log result
      const statusEmoji =
        result.decision === 'fresh' ? '✅' : result.decision === 'stale' ? '⚠️' : '❌';

      console.log(
        `   ${progress} ${statusEmoji} ${finding.domain} (score: ${result.score}, ${result.decision})`
      );
      console.log(
        `           Checked ${result.employeesChecked} employees: ${result.employeesConfirmed} confirmed, ${result.employeesLeft} left, ${result.employeesUnknown} unknown`
      );

      if (result.reasons.length > 0) {
        console.log(`           ${result.reasons.join(', ')}`);
      }

      // Update database (unless dry run)
      if (!options.dryRun) {
        await updateFindingValidation(finding.id, result);
      }

      // Track stats
      if (result.decision === 'fresh') fresh++;
      else if (result.decision === 'stale') stale++;
      else invalid++;

      // Rate limiting: ~300ms between validations (Apollo is rate-limited)
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (error: any) {
      console.log(`   ${progress} ❓ ${finding.domain} - Error: ${error.message}`);
      errors++;
    }
  }

  // Summary
  console.log('\n📊 Validation Summary\n');
  console.log(`   Total processed: ${findings.length}`);
  console.log(`   ✅ Fresh: ${fresh}`);
  console.log(`   ⚠️  Stale: ${stale}`);
  console.log(`   ❌ Invalid: ${invalid}`);
  if (errors > 0) {
    console.log(`   ❓ Errors: ${errors}`);
  }

  if (options.dryRun) {
    console.log('\n   (Dry run - no changes made)');
  } else {
    console.log(`\n   ${fresh + stale + invalid} findings updated`);
    console.log('\n   Next step: Only fresh findings should be enriched.');
    console.log('   Run: npm run campaign:enrich -- --require-validation');
  }
}

async function pauseOutbound(): Promise<void> {
  console.log('\n⏸️  Pausing Outbound Campaigns\n');

  // Disable all active sender accounts (status constraint: active, disabled, error, rate_limited)
  const result = await pool.query(`
    UPDATE sender_accounts
    SET status = 'disabled'
    WHERE status = 'active'
    RETURNING email
  `);

  if (result.rowCount === 0) {
    console.log('   No active sender accounts to pause.');
  } else {
    console.log(`   Disabled ${result.rowCount} sender accounts:`);
    for (const row of result.rows) {
      console.log(`     - ${row.email}`);
    }
  }

  console.log('\n   ✅ Outbound paused. Run with --resume-outbound to re-enable.');
}

async function resumeOutbound(): Promise<void> {
  console.log('\n▶️  Resuming Outbound Campaigns\n');

  // Re-enable disabled sender accounts
  const result = await pool.query(`
    UPDATE sender_accounts
    SET status = 'active'
    WHERE status = 'disabled'
    RETURNING email
  `);

  if (result.rowCount === 0) {
    console.log('   No disabled sender accounts to resume.');
  } else {
    console.log(`   Resumed ${result.rowCount} sender accounts:`);
    for (const row of result.rows) {
      console.log(`     - ${row.email}`);
    }
  }

  console.log('\n   ✅ Outbound resumed.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  const showStatusOnly = args.includes('--status');
  const dryRun = args.includes('--dry-run');
  const revalidate = args.includes('--revalidate');
  const skipBatchCheck = args.includes('--skip-batch-check');
  const pauseOutboundFlag = args.includes('--pause-outbound');
  const resumeOutboundFlag = args.includes('--resume-outbound');

  let limit = 50;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  let domain: string | undefined;
  const domainIdx = args.indexOf('--domain');
  if (domainIdx >= 0 && args[domainIdx + 1]) {
    domain = args[domainIdx + 1];
  }

  if (args.includes('--help')) {
    console.log(`
Infostealer Finding Validation (GATE 1)

Validates exposed employee emails BEFORE enrichment to avoid
wasting Apollo credits on stale findings.

IMPORTANT: By default, this script ONLY validates scans that have a
valid contact in infostealer_batch_results (from free batch search).
You MUST run the batch people search first!

Pipeline order:
  1. npm run discover:pipeline:infostealer -- --batch-only   # FREE batch search
  2. npm run validate:findings                                # This script
  3. npm run discover:pipeline:infostealer -- --enrich-only  # Enrich contacts

Usage:
  npm run validate:findings [options]

Options:
  --limit <n>          Max findings to validate (default: 50)
  --domain <domain>    Validate specific domain only
  --skip-batch-check   DANGEROUS: Skip batch results check (wastes credits!)
  --dry-run            Preview without updating database
  --status             Show validation statistics
  --revalidate         Re-validate stale findings
  --pause-outbound     Pause all sender accounts (stop sending)
  --resume-outbound    Resume paused sender accounts
  --help               Show this help

Examples:
  # Normal usage (only validates scans with valid contacts from batch search)
  npm run validate:findings -- --limit 100

  # Dry run to preview
  npm run validate:findings -- --dry-run

  # Check validation status
  npm run validate:findings -- --status
    `);
    process.exit(0);
  }

  try {
    if (pauseOutboundFlag) {
      await pauseOutbound();
    } else if (resumeOutboundFlag) {
      await resumeOutbound();
    } else if (showStatusOnly) {
      await showStatus();
    } else {
      await validateFindings({ limit, domain, dryRun, revalidate, skipBatchCheck });
    }
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
