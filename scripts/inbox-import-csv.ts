#!/usr/bin/env npx tsx

/**
 * Import sender accounts from mailboxes.csv
 */

import { config } from 'dotenv';
import { Pool } from 'pg';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { encryptCredentials } from '../apps/inbox/core/crypto.js';

config();

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/scanner_local';
const pool = new Pool({ connectionString: DATABASE_URL });

interface MailboxRow {
  Provider: string;
  Domain: string;
  Email: string;
  Name: string;
  Password: string;
}

async function importAccounts() {
  console.log('\n📧 Importing accounts from mailboxes.csv\n');

  // Check encryption key
  if (!process.env.SENDER_ENCRYPTION_KEY) {
    console.error('❌ SENDER_ENCRYPTION_KEY not set in .env');
    process.exit(1);
  }

  // Read CSV
  const csvContent = readFileSync('mailboxes.csv', 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true
  }) as MailboxRow[];

  console.log(`📋 Found ${records.length} accounts in CSV\n`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of records) {
    const email = row.Email;
    const provider = row.Provider === 'google' ? 'gmail' : 'microsoft';
    const displayName = row.Name;
    const password = row.Password;

    try {
      // Check if already exists
      const existing = await pool.query(
        'SELECT id FROM sender_accounts WHERE email = $1',
        [email]
      );

      if (existing.rows.length > 0) {
        console.log(`  ⏭️  ${email} (already exists)`);
        skipped++;
        continue;
      }

      // Encrypt credentials
      const encrypted = encryptCredentials({ password });

      // Insert
      await pool.query(`
        INSERT INTO sender_accounts (
          email,
          display_name,
          provider,
          auth_type,
          credentials_encrypted,
          credentials_iv,
          credentials_tag,
          daily_limit,
          tags,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        email,
        displayName,
        provider,
        'password',  // All these use password auth (app passwords for Gmail)
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag,
        provider === 'gmail' ? 100 : 50,  // Gmail allows more via app password
        [row.Domain],  // Tag with domain for easy filtering
        'active'
      ]);

      console.log(`  ✅ ${email} (${provider})`);
      added++;

    } catch (err: any) {
      console.log(`  ❌ ${email}: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`📊 Import Summary:`);
  console.log(`   ✅ Added: ${added}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📋 Total: ${records.length}`);
  console.log('');

  // Show account breakdown
  const countResult = await pool.query(`
    SELECT provider, COUNT(*) as count
    FROM sender_accounts
    GROUP BY provider
  `);

  console.log('📧 Accounts by Provider:');
  for (const row of countResult.rows) {
    console.log(`   ${row.provider}: ${row.count}`);
  }
  console.log('');
}

async function main() {
  try {
    await importAccounts();
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
