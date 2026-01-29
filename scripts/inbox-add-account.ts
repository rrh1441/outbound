#!/usr/bin/env npx tsx

/**
 * Add Sender Account to Unified Inbox
 *
 * Interactive script to add Gmail or Microsoft accounts.
 * Credentials are encrypted before storing in database.
 */

import { config } from 'dotenv';
import * as readline from 'readline';
import { encryptCredentials, generateEncryptionKey } from '../apps/inbox/core/crypto.js';
import { EmailClient, SenderAccount } from '../apps/inbox/core/email-client.js';
import { getPool } from '../lib/database.js';

config();

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();

    let password = '';

    stdin.on('data', function handler(ch) {
      const char = ch.toString('utf8');

      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener('data', handler);
          console.log('');
          resolve(password);
          break;
        case '\u0003':
          process.exit();
          break;
        case '\u007F': // Backspace
          password = password.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(prompt + '*'.repeat(password.length));
          break;
        default:
          password += char;
          process.stdout.write('*');
          break;
      }
    });
  });
}

async function addAccount() {
  console.log('\n📧 Add Sender Account\n');

  // Check encryption key
  if (!process.env.SENDER_ENCRYPTION_KEY) {
    console.log('⚠️  SENDER_ENCRYPTION_KEY not set in .env');
    console.log('\nGenerate one with this command:\n');
    console.log(`  echo 'SENDER_ENCRYPTION_KEY="${generateEncryptionKey()}"' >> .env`);
    console.log('\nThen run this script again.\n');
    process.exit(1);
  }

  // Get provider
  const providerInput = await question('Provider (gmail/microsoft) [microsoft]: ');
  const provider = (providerInput.toLowerCase() || 'microsoft') as 'gmail' | 'microsoft';

  if (!['gmail', 'microsoft'].includes(provider)) {
    console.error('❌ Invalid provider. Use "gmail" or "microsoft"');
    process.exit(1);
  }

  // Get email
  const email = await question('Email address: ');
  if (!email || !email.includes('@')) {
    console.error('❌ Invalid email address');
    process.exit(1);
  }

  // Check if already exists
  const existing = await pool.query('SELECT id FROM sender_accounts WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.error(`❌ Account ${email} already exists`);
    process.exit(1);
  }

  // Get display name
  const displayName = await question('Display name (optional): ');

  // Get credentials
  let credentials: Record<string, string>;
  let authType: 'oauth' | 'password';

  if (provider === 'microsoft') {
    // Microsoft uses password auth via SMTP/IMAP
    const password = await questionHidden('Password: ');
    credentials = { password };
    authType = 'password';
  } else {
    // Gmail - check if we should use OAuth or app password
    const authChoice = await question('Auth type (oauth/app_password) [oauth]: ');

    if (authChoice === 'app_password') {
      const password = await questionHidden('App password (16 chars, no spaces): ');
      credentials = { password: password.replace(/\s/g, '') };
      authType = 'password';
    } else {
      // OAuth - need to run the auth flow
      console.log('\n📋 For Gmail OAuth, you need to run the auth flow first.');
      console.log('   Run: npm run campaign:auth');
      console.log('   Then come back and enter the refresh token.\n');
      const refreshToken = await question('Refresh token: ');
      credentials = { refresh_token: refreshToken };
      authType = 'oauth';
    }
  }

  // Get daily limit
  const limitInput = await question('Daily send limit [50]: ');
  const dailyLimit = parseInt(limitInput) || 50;

  // Get tags
  const tagsInput = await question('Tags (comma-separated, e.g., tips,primary): ');
  const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()) : [];

  console.log('\n⏳ Encrypting credentials...');
  const encrypted = encryptCredentials(credentials);

  console.log('⏳ Testing connection...');

  // Create temporary account object for testing
  const testAccount: SenderAccount = {
    id: 'test',
    email,
    display_name: displayName || null,
    provider,
    auth_type: authType,
    credentials_encrypted: encrypted.encrypted,
    credentials_iv: encrypted.iv,
    credentials_tag: encrypted.tag,
    smtp_host: null,
    smtp_port: null,
    imap_host: null,
    imap_port: null,
    status: 'active',
    daily_limit: dailyLimit,
    emails_sent_today: 0
  };

  const client = new EmailClient(testAccount);
  const testResult = await client.testConnection();
  client.close();

  if (!testResult.smtp || !testResult.imap) {
    console.log('\n⚠️  Connection test results:');
    console.log(`   SMTP: ${testResult.smtp ? '✅' : '❌'}`);
    console.log(`   IMAP: ${testResult.imap ? '✅' : '❌'}`);

    if (testResult.errors.length > 0) {
      console.log('\n   Errors:');
      testResult.errors.forEach(e => console.log(`   - ${e}`));
    }

    const proceed = await question('\nProceed anyway? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      console.log('❌ Aborted');
      process.exit(1);
    }
  } else {
    console.log('✅ Connection test passed (SMTP + IMAP)');
  }

  // Insert into database
  console.log('\n⏳ Saving to database...');

  const result = await pool.query(`
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
    RETURNING id
  `, [
    email,
    displayName || null,
    provider,
    authType,
    encrypted.encrypted,
    encrypted.iv,
    encrypted.tag,
    dailyLimit,
    tags,
    testResult.smtp && testResult.imap ? 'active' : 'error'
  ]);

  console.log(`\n✅ Account added successfully!`);
  console.log(`   ID: ${result.rows[0].id}`);
  console.log(`   Email: ${email}`);
  console.log(`   Provider: ${provider}`);
  console.log(`   Status: ${testResult.smtp && testResult.imap ? 'active' : 'error (check credentials)'}`);
}

async function bulkAddMicrosoft() {
  console.log('\n📧 Bulk Add Microsoft Accounts\n');

  if (!process.env.SENDER_ENCRYPTION_KEY) {
    console.log('⚠️  SENDER_ENCRYPTION_KEY not set. Generate one first.\n');
    console.log(`  echo 'SENDER_ENCRYPTION_KEY="${generateEncryptionKey()}"' >> .env\n`);
    process.exit(1);
  }

  console.log('Enter accounts in format: email:password (one per line)');
  console.log('Enter a blank line when done.\n');

  const accounts: { email: string; password: string }[] = [];

  while (true) {
    const line = await question('> ');
    if (!line.trim()) break;

    const [email, password] = line.split(':');
    if (!email || !password) {
      console.log('  ⚠️  Invalid format, skipping');
      continue;
    }

    accounts.push({ email: email.trim(), password: password.trim() });
    console.log(`  ✓ Added ${email.trim()}`);
  }

  if (accounts.length === 0) {
    console.log('❌ No accounts to add');
    process.exit(1);
  }

  console.log(`\n⏳ Adding ${accounts.length} accounts...`);

  let added = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      // Check if exists
      const existing = await pool.query('SELECT id FROM sender_accounts WHERE email = $1', [account.email]);
      if (existing.rows.length > 0) {
        console.log(`  ⚠️  ${account.email} already exists, skipping`);
        continue;
      }

      // Encrypt
      const encrypted = encryptCredentials({ password: account.password });

      // Insert
      await pool.query(`
        INSERT INTO sender_accounts (
          email,
          provider,
          auth_type,
          credentials_encrypted,
          credentials_iv,
          credentials_tag,
          daily_limit,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        account.email,
        'microsoft',
        'password',
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag,
        50,
        'active'
      ]);

      console.log(`  ✅ ${account.email}`);
      added++;
    } catch (err: any) {
      console.log(`  ❌ ${account.email}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Added: ${added}`);
  console.log(`   Failed: ${failed}`);
}

async function listAccounts() {
  console.log('\n📧 Sender Accounts\n');

  const result = await pool.query(`
    SELECT
      id, email, provider, status, daily_limit,
      emails_sent_today, last_sent_at, last_sync_at, tags
    FROM sender_accounts
    ORDER BY provider, email
  `);

  if (result.rows.length === 0) {
    console.log('No accounts found. Run with --add to add one.\n');
    return;
  }

  console.log('━'.repeat(100));
  console.log(
    'EMAIL'.padEnd(40) +
    'PROVIDER'.padEnd(12) +
    'STATUS'.padEnd(10) +
    'SENT/LIMIT'.padEnd(12) +
    'TAGS'
  );
  console.log('━'.repeat(100));

  for (const row of result.rows) {
    console.log(
      row.email.padEnd(40) +
      row.provider.padEnd(12) +
      row.status.padEnd(10) +
      `${row.emails_sent_today}/${row.daily_limit}`.padEnd(12) +
      (row.tags || []).join(', ')
    );
  }

  console.log('━'.repeat(100));
  console.log(`Total: ${result.rows.length} accounts\n`);
}

async function updateAccount() {
  console.log('\n📧 Update Sender Account Credentials\n');

  if (!process.env.SENDER_ENCRYPTION_KEY) {
    console.log('⚠️  SENDER_ENCRYPTION_KEY not set in .env');
    process.exit(1);
  }

  // Get email
  const email = await question('Email address to update: ');
  if (!email || !email.includes('@')) {
    console.error('❌ Invalid email address');
    process.exit(1);
  }

  // Check if exists
  const existing = await pool.query(
    'SELECT id, provider, auth_type FROM sender_accounts WHERE email = $1',
    [email]
  );
  if (existing.rows.length === 0) {
    console.error(`❌ Account ${email} not found`);
    process.exit(1);
  }

  const account = existing.rows[0];
  console.log(`Found account: ${email} (${account.provider})`);

  // Get new credentials
  let credentials: Record<string, string>;
  let authType = account.auth_type;

  if (account.provider === 'microsoft') {
    const password = await questionHidden('New password: ');
    credentials = { password };
    authType = 'password';
  } else {
    const authChoice = await question('Auth type (oauth/app_password) [oauth]: ');
    if (authChoice === 'app_password') {
      const password = await questionHidden('App password: ');
      credentials = { password: password.replace(/\s/g, '') };
      authType = 'password';
    } else {
      const refreshToken = await question('New refresh token: ');
      credentials = { refresh_token: refreshToken };
      authType = 'oauth';
    }
  }

  console.log('\n⏳ Encrypting credentials...');
  const encrypted = encryptCredentials(credentials);

  console.log('⏳ Testing connection...');

  // Create temporary account object for testing
  const testAccount: SenderAccount = {
    id: account.id,
    email,
    display_name: null,
    provider: account.provider,
    auth_type: authType,
    credentials_encrypted: encrypted.encrypted,
    credentials_iv: encrypted.iv,
    credentials_tag: encrypted.tag,
    smtp_host: null,
    smtp_port: null,
    imap_host: null,
    imap_port: null,
    status: 'active',
    daily_limit: 50,
    emails_sent_today: 0
  };

  const client = new EmailClient(testAccount);
  const testResult = await client.testConnection();
  client.close();

  if (!testResult.smtp || !testResult.imap) {
    console.log('\n⚠️  Connection test results:');
    console.log(`   SMTP: ${testResult.smtp ? '✅' : '❌'}`);
    console.log(`   IMAP: ${testResult.imap ? '✅' : '❌'}`);

    if (testResult.errors.length > 0) {
      console.log('\n   Errors:');
      testResult.errors.forEach(e => console.log(`   - ${e}`));
    }

    const proceed = await question('\nProceed anyway? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      console.log('❌ Aborted');
      process.exit(1);
    }
  } else {
    console.log('✅ Connection test passed (SMTP + IMAP)');
  }

  // Update database
  console.log('\n⏳ Updating database...');

  await pool.query(`
    UPDATE sender_accounts SET
      auth_type = $2,
      credentials_encrypted = $3,
      credentials_iv = $4,
      credentials_tag = $5,
      status = $6,
      last_error = NULL,
      updated_at = NOW()
    WHERE id = $1
  `, [
    account.id,
    authType,
    encrypted.encrypted,
    encrypted.iv,
    encrypted.tag,
    testResult.smtp && testResult.imap ? 'active' : 'error'
  ]);

  console.log(`\n✅ Account updated successfully!`);
  console.log(`   Email: ${email}`);
  console.log(`   Status: ${testResult.smtp && testResult.imap ? 'active' : 'error'}`);
}

async function bulkUpdateMicrosoft() {
  console.log('\n📧 Bulk Update Microsoft Account Credentials\n');

  if (!process.env.SENDER_ENCRYPTION_KEY) {
    console.log('⚠️  SENDER_ENCRYPTION_KEY not set. Generate one first.\n');
    process.exit(1);
  }

  console.log('Enter accounts in format: email:password (one per line)');
  console.log('Enter a blank line when done.\n');

  const accounts: { email: string; password: string }[] = [];

  while (true) {
    const line = await question('> ');
    if (!line.trim()) break;

    const [email, password] = line.split(':');
    if (!email || !password) {
      console.log('  ⚠️  Invalid format, skipping');
      continue;
    }

    accounts.push({ email: email.trim(), password: password.trim() });
    console.log(`  ✓ Queued ${email.trim()}`);
  }

  if (accounts.length === 0) {
    console.log('❌ No accounts to update');
    process.exit(1);
  }

  console.log(`\n⏳ Updating ${accounts.length} accounts...`);

  let updated = 0;
  let failed = 0;
  let notFound = 0;

  for (const account of accounts) {
    try {
      // Check if exists
      const existing = await pool.query(
        'SELECT id FROM sender_accounts WHERE email = $1',
        [account.email]
      );
      if (existing.rows.length === 0) {
        console.log(`  ⚠️  ${account.email} not found, skipping`);
        notFound++;
        continue;
      }

      // Encrypt
      const encrypted = encryptCredentials({ password: account.password });

      // Update
      await pool.query(`
        UPDATE sender_accounts SET
          credentials_encrypted = $2,
          credentials_iv = $3,
          credentials_tag = $4,
          status = 'active',
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $1
      `, [
        existing.rows[0].id,
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag
      ]);

      console.log(`  ✅ ${account.email}`);
      updated++;
    } catch (err: any) {
      console.log(`  ❌ ${account.email}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Not found: ${notFound}`);
  console.log(`   Failed: ${failed}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Unified Inbox Account Manager

Usage:
  npm run inbox:add-account [options]

Options:
  --add           Add a single account interactively
  --bulk          Bulk add Microsoft accounts (email:password format)
  --update        Update credentials for a single existing account
  --bulk-update   Bulk update Microsoft account credentials
  --list          List all accounts
  --help          Show this help

Examples:
  npm run inbox:add-account --list
  npm run inbox:add-account --add
  npm run inbox:add-account --bulk
  npm run inbox:add-account --update
  npm run inbox:add-account --bulk-update
    `);
    process.exit(0);
  }

  try {
    if (args.includes('--bulk-update')) {
      await bulkUpdateMicrosoft();
    } else if (args.includes('--update')) {
      await updateAccount();
    } else if (args.includes('--bulk')) {
      await bulkAddMicrosoft();
    } else if (args.includes('--list')) {
      await listAccounts();
    } else {
      await addAccount();
    }
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
