#!/usr/bin/env npx tsx

/**
 * Bulk Email Verification
 *
 * Uses EmailListChecker.io API to verify enriched emails from Apollo.
 *
 * Workflow:
 *   1. Export emails from campaign_contacts to CSV
 *   2. Upload CSV to EmailListChecker.io
 *   3. Poll for completion
 *   4. Download results and update database
 *
 * Usage:
 *   npm run verify:emails -- --export          # Step 1: Export emails to CSV
 *   npm run verify:emails -- --upload          # Step 2: Upload and start verification
 *   npm run verify:emails -- --status          # Step 3: Check progress
 *   npm run verify:emails -- --download        # Step 4: Download results and update DB
 *   npm run verify:emails -- --full            # Run full workflow (export → upload → poll → download)
 */

import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../lib/database.js';

config();

const API_BASE_URL = 'https://platform.emaillistchecker.io/api';
const API_KEY = process.env.EMAIL_VERIFIER_API_KEY;

// File paths
const EXPORT_DIR = path.join(process.cwd(), 'email-verification');
const EXPORT_FILE = path.join(EXPORT_DIR, 'emails-to-verify.csv');
const RESULTS_FILE = path.join(EXPORT_DIR, 'verification-results.csv');
const STATE_FILE = path.join(EXPORT_DIR, 'verification-state.json');

const pool = getPool();

interface VerificationState {
  list_id: number | null;
  total_emails: number;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  started_at: string | null;
  completed_at: string | null;
}

function loadState(): VerificationState {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return {
    list_id: null,
    total_emails: 0,
    status: 'pending',
    started_at: null,
    completed_at: null
  };
}

function saveState(state: VerificationState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function exportEmails(): Promise<number> {
  console.log('📤 Exporting emails from campaign_contacts...\n');

  // Create export directory if it doesn't exist
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  // Check if email_verified column exists
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'campaign_contacts' AND column_name = 'email_verified'
  `);

  // Get all unique emails that haven't been verified yet
  let result;
  if (colCheck.rows.length === 0) {
    // Column doesn't exist - get all emails
    result = await pool.query(`
      SELECT DISTINCT email
      FROM campaign_contacts
      WHERE email IS NOT NULL
        AND email != ''
      ORDER BY email
    `);
  } else {
    // Column exists - filter by unverified
    result = await pool.query(`
      SELECT DISTINCT email
      FROM campaign_contacts
      WHERE email IS NOT NULL
        AND email != ''
        AND (email_verified IS NULL OR email_verified = false)
      ORDER BY email
    `);
  }

  if (result.rows.length === 0) {
    console.log('✅ No emails to verify (all already verified or none exist)');
    return 0;
  }

  // Write CSV file (just emails, one per line)
  const csvContent = result.rows.map(r => r.email).join('\n');
  fs.writeFileSync(EXPORT_FILE, csvContent);

  console.log(`✅ Exported ${result.rows.length} emails to ${EXPORT_FILE}`);

  // Update state
  const state = loadState();
  state.total_emails = result.rows.length;
  state.status = 'pending';
  saveState(state);

  return result.rows.length;
}

async function uploadForVerification(): Promise<number | null> {
  console.log('📤 Uploading emails to EmailListChecker.io...\n');

  if (!API_KEY) {
    console.error('❌ EMAIL_VERIFIER_API_KEY not set in .env');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORT_FILE)) {
    console.error(`❌ Export file not found: ${EXPORT_FILE}`);
    console.error('   Run with --export first');
    process.exit(1);
  }

  const fileContent = fs.readFileSync(EXPORT_FILE);
  const formData = new FormData();
  formData.append('file', new Blob([fileContent], { type: 'text/csv' }), 'emails.csv');

  try {
    const response = await fetch(`${API_BASE_URL}/bulk-upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Upload failed: ${response.status}`);
      console.error(`   ${errorText}`);
      return null;
    }

    const data = await response.json();

    if (data.success) {
      console.log(`✅ Upload successful!`);
      console.log(`   List ID: ${data.list_id}`);
      console.log(`   Total emails: ${data.total_emails}`);
      console.log(`   Message: ${data.message}`);

      // Update state
      const state = loadState();
      state.list_id = data.list_id;
      state.total_emails = data.total_emails;
      state.status = 'processing';
      state.started_at = new Date().toISOString();
      saveState(state);

      return data.list_id;
    } else {
      console.error('❌ Upload failed:', data);
      return null;
    }
  } catch (error: any) {
    console.error(`❌ Upload error: ${error.message}`);
    return null;
  }
}

async function checkStatus(listId?: number): Promise<any> {
  const state = loadState();
  const id = listId || state.list_id;

  if (!id) {
    console.error('❌ No list_id found. Run --upload first.');
    return null;
  }

  if (!API_KEY) {
    console.error('❌ EMAIL_VERIFIER_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`📊 Checking verification status for list ${id}...\n`);

  try {
    const response = await fetch(`${API_BASE_URL}/bulk-verification/${id}/progress`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Status check failed: ${response.status}`);
      console.error(`   ${errorText}`);
      return null;
    }

    const data = await response.json();

    if (data.success) {
      const status = data.data;
      console.log(`   Status: ${status.status}`);
      console.log(`   Progress: ${status.progress}%`);
      console.log(`   Total: ${status.total_emails}`);
      console.log(`   Processed: ${status.processed_emails}`);
      console.log(`   ✅ Valid: ${status.valid_emails}`);
      console.log(`   ❌ Invalid: ${status.invalid_emails}`);
      console.log(`   ❓ Unknown: ${status.unknown_emails}`);
      console.log(`   🔄 Catch-all: ${status.catch_all_emails}`);

      if (status.started_at) {
        console.log(`   Started: ${status.started_at}`);
      }
      if (status.completed_at) {
        console.log(`   Completed: ${status.completed_at}`);
      }

      // Update state
      state.status = status.status;
      if (status.status === 'completed') {
        state.completed_at = status.completed_at;
      }
      saveState(state);

      return status;
    } else {
      console.error('❌ Status check failed:', data);
      return null;
    }
  } catch (error: any) {
    console.error(`❌ Status check error: ${error.message}`);
    return null;
  }
}

async function downloadResults(listId?: number): Promise<boolean> {
  const state = loadState();
  const id = listId || state.list_id;

  if (!id) {
    console.error('❌ No list_id found. Run --upload first.');
    return false;
  }

  if (!API_KEY) {
    console.error('❌ EMAIL_VERIFIER_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`📥 Downloading verification results for list ${id}...\n`);

  try {
    // Download all results as CSV
    const response = await fetch(`${API_BASE_URL}/bulk-verification/${id}/download?format=csv&filter=all`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Download failed: ${response.status}`);
      console.error(`   ${errorText}`);
      return false;
    }

    const csvContent = await response.text();
    fs.writeFileSync(RESULTS_FILE, csvContent);
    console.log(`✅ Results saved to ${RESULTS_FILE}`);

    // Parse and update database
    await updateDatabaseFromResults(csvContent);

    return true;
  } catch (error: any) {
    console.error(`❌ Download error: ${error.message}`);
    return false;
  }
}

async function updateDatabaseFromResults(csvContent: string): Promise<void> {
  console.log('\n📊 Updating database with verification results...\n');

  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    console.log('⚠️  No results to process');
    return;
  }

  // Parse header to find column indices
  const header = lines[0].toLowerCase().split(',');
  const emailIdx = header.findIndex(h => h.includes('email'));
  const statusIdx = header.findIndex(h => h.includes('status') || h.includes('result'));

  if (emailIdx === -1) {
    console.error('❌ Could not find email column in results');
    console.log('   Header:', header);
    return;
  }

  console.log(`   Email column: ${emailIdx}`);
  console.log(`   Status column: ${statusIdx >= 0 ? statusIdx : 'not found (will mark all as verified)'}`);

  // Ensure columns exist
  await addVerificationColumns();

  let valid = 0;
  let invalid = 0;
  let catchAll = 0;
  let unknown = 0;
  let updated = 0;
  let archived = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const email = cols[emailIdx];
    const status = statusIdx >= 0 ? cols[statusIdx]?.toLowerCase() : 'valid';

    if (!email) continue;

    // Determine verification status
    const isValid = status === 'valid' || status === 'ok' || status === 'deliverable';
    const isInvalid = status === 'invalid' || status === 'undeliverable' || status === 'bad';
    const isCatchAll = status === 'catch-all' || status === 'catch_all' || status === 'catchall' || status === 'accept-all';

    if (isValid) valid++;
    else if (isCatchAll) catchAll++;
    else if (isInvalid) invalid++;
    else unknown++;

    // Update database
    try {
      if (isInvalid) {
        // Archive invalid emails
        const archiveResult = await pool.query(`
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
            'invalid_email', created_at
          FROM campaign_contacts
          WHERE email = $1
          ON CONFLICT (id) DO NOTHING
        `, [email]);

        // Delete from main table
        await pool.query(`DELETE FROM campaign_contacts WHERE email = $1`, [email]);

        if (archiveResult.rowCount && archiveResult.rowCount > 0) {
          archived++;
        }
      } else {
        // Update verification status for valid/catch-all
        const result = await pool.query(`
          UPDATE campaign_contacts
          SET
            email_verified = $1,
            email_verification_status = $2,
            email_verified_at = NOW(),
            is_catch_all = $4
          WHERE email = $3
        `, [isValid || isCatchAll, status, email, isCatchAll]);

        if (result.rowCount && result.rowCount > 0) {
          updated++;
        }
      }
    } catch (error: any) {
      console.error(`   Error processing ${email}: ${error.message}`);
    }
  }

  console.log(`\n📊 Results Summary:`);
  console.log(`   ✅ Valid: ${valid}`);
  console.log(`   🔄 Catch-all: ${catchAll}`);
  console.log(`   ❌ Invalid: ${invalid}`);
  console.log(`   ❓ Unknown: ${unknown}`);
  console.log(`   📝 DB rows updated: ${updated}`);
  console.log(`   📦 Archived (invalid): ${archived}`);
}

async function addVerificationColumns(): Promise<void> {
  await pool.query(`
    ALTER TABLE campaign_contacts
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN,
    ADD COLUMN IF NOT EXISTS email_verification_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS is_catch_all BOOLEAN DEFAULT false
  `);
  console.log('✅ Added verification columns (including is_catch_all)');
}

async function runFullWorkflow(): Promise<void> {
  console.log('🚀 Running full email verification workflow\n');
  console.log('=' .repeat(60) + '\n');

  // Step 1: Export
  console.log('Step 1/4: Export emails\n');
  const count = await exportEmails();
  if (count === 0) {
    console.log('\n✅ Nothing to verify!');
    return;
  }

  // Step 2: Upload
  console.log('\n' + '=' .repeat(60));
  console.log('\nStep 2/4: Upload for verification\n');
  const listId = await uploadForVerification();
  if (!listId) {
    console.error('\n❌ Upload failed, stopping workflow');
    return;
  }

  // Step 3: Poll for completion
  console.log('\n' + '=' .repeat(60));
  console.log('\nStep 3/4: Waiting for verification to complete...\n');

  let status: any = null;
  const pollInterval = 10000; // 10 seconds
  const maxWait = 30 * 60 * 1000; // 30 minutes max
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    status = await checkStatus(listId);

    if (!status) {
      console.error('\n❌ Failed to get status');
      return;
    }

    if (status.status === 'completed') {
      console.log('\n✅ Verification completed!');
      break;
    }

    if (status.status === 'failed') {
      console.error('\n❌ Verification failed');
      return;
    }

    console.log(`\n   ⏳ Progress: ${status.progress}% - waiting ${pollInterval/1000}s...\n`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  if (status?.status !== 'completed') {
    console.error('\n❌ Verification timed out');
    return;
  }

  // Step 4: Download and update
  console.log('\n' + '=' .repeat(60));
  console.log('\nStep 4/4: Download results and update database\n');
  await downloadResults(listId);

  console.log('\n' + '=' .repeat(60));
  console.log('\n✅ Full workflow completed!');
}

async function showStats(): Promise<void> {
  console.log('📊 Email Verification Statistics\n');

  // Check if email_verified column exists
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'campaign_contacts' AND column_name = 'email_verified'
  `);

  if (colCheck.rows.length === 0) {
    // Column doesn't exist yet
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM campaign_contacts WHERE email IS NOT NULL
    `);
    console.log(`   Total emails: ${countResult.rows[0].total}`);
    console.log(`   ⏳ Not yet verified: ${countResult.rows[0].total}`);
    console.log(`\n   (Run --export and --upload to start verification)`);

    // Show state file info
    const state = loadState();
    if (state.list_id) {
      console.log(`\n   Last list ID: ${state.list_id}`);
      console.log(`   Last status: ${state.status}`);
    }
    return;
  }

  const stats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN email_verified = true THEN 1 END) as verified_valid,
      COUNT(CASE WHEN email_verified = false THEN 1 END) as verified_invalid,
      COUNT(CASE WHEN email_verified IS NULL THEN 1 END) as not_verified
    FROM campaign_contacts
    WHERE email IS NOT NULL
  `);

  const row = stats.rows[0];
  console.log(`   Total emails: ${row.total}`);
  console.log(`   ✅ Verified (valid): ${row.verified_valid}`);
  console.log(`   ❌ Verified (invalid): ${row.verified_invalid}`);
  console.log(`   ⏳ Not yet verified: ${row.not_verified}`);

  // Show state file info
  const state = loadState();
  if (state.list_id) {
    console.log(`\n   Last list ID: ${state.list_id}`);
    console.log(`   Last status: ${state.status}`);
    if (state.started_at) console.log(`   Started: ${state.started_at}`);
    if (state.completed_at) console.log(`   Completed: ${state.completed_at}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!API_KEY) {
    console.error('❌ EMAIL_VERIFIER_API_KEY not set in .env');
    process.exit(1);
  }

  console.log('🔍 Email Verification Tool (EmailListChecker.io)\n');

  if (args.includes('--help') || args.length === 0) {
    console.log('Usage:');
    console.log('  --export    Export emails from database to CSV');
    console.log('  --upload    Upload CSV to verification service');
    console.log('  --status    Check verification progress');
    console.log('  --download  Download results and update database');
    console.log('  --full      Run complete workflow (export → upload → poll → download)');
    console.log('  --stats     Show verification statistics');
    console.log('');
    await showStats();
    await pool.end();
    return;
  }

  try {
    if (args.includes('--export')) {
      await exportEmails();
    } else if (args.includes('--upload')) {
      await uploadForVerification();
    } else if (args.includes('--status')) {
      await checkStatus();
    } else if (args.includes('--download')) {
      await downloadResults();
    } else if (args.includes('--full')) {
      await runFullWorkflow();
    } else if (args.includes('--stats')) {
      await showStats();
    } else {
      console.log('Unknown option. Use --help for usage.');
    }
  } finally {
    await pool.end();
  }
}

main().catch(async error => {
  console.error('\n❌ Fatal error:', error);
  await pool.end();
  process.exit(1);
});
