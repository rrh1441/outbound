#!/usr/bin/env npx tsx

/**
 * Gmail OAuth Authentication for Inbox Accounts
 *
 * Runs OAuth flow for Gmail accounts and updates their credentials.
 * Uses the same Google Cloud app as campaign:auth.
 */

import { config } from 'dotenv';
import { Pool } from 'pg';
import { google } from 'googleapis';
import * as readline from 'readline';
import { encryptCredentials } from '../apps/inbox/core/crypto.js';

config();

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/scanner_local';
const pool = new Pool({ connectionString: DATABASE_URL });

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function authGmailAccount(email: string): Promise<string | null> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

  if (!clientId || !clientSecret) {
    console.error('❌ GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account consent',  // Force account picker
    login_hint: email
  });

  console.log(`\n📧 Authenticating: ${email}`);
  console.log('━'.repeat(70));
  console.log('\n1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in with: ' + email);
  console.log('3. Click "Advanced" → "Go to SimplCyber..." → "Allow"');
  console.log('4. Copy the FULL redirect URL from your browser\n');

  const redirectUrl = await question('Paste redirect URL: ');

  try {
    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code');

    if (!code) {
      console.error('❌ No authorization code found in URL');
      return null;
    }

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error('❌ No refresh token received. Try revoking access and re-authorizing.');
      return null;
    }

    // Verify the token works
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    if (profile.data.emailAddress?.toLowerCase() !== email.toLowerCase()) {
      console.error(`❌ Authenticated as ${profile.data.emailAddress} but expected ${email}`);
      return null;
    }

    console.log(`✅ Authenticated as ${profile.data.emailAddress}`);
    return tokens.refresh_token;

  } catch (err: any) {
    console.error(`❌ Error: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('\n🔐 Gmail OAuth Setup for Inbox Accounts\n');

  // Get all Gmail accounts
  const result = await pool.query(`
    SELECT id, email, display_name
    FROM sender_accounts
    WHERE provider = 'gmail'
    ORDER BY email
  `);

  const gmailAccounts = result.rows;

  if (gmailAccounts.length === 0) {
    console.log('No Gmail accounts found in sender_accounts table.');
    process.exit(0);
  }

  console.log(`Found ${gmailAccounts.length} Gmail accounts:\n`);
  gmailAccounts.forEach((acc, i) => {
    console.log(`  ${i + 1}. ${acc.email}`);
  });

  const choice = await question('\nAuth all accounts? (y/N) or enter number for specific: ');

  let accountsToAuth = gmailAccounts;

  if (choice.toLowerCase() !== 'y') {
    const num = parseInt(choice);
    if (num >= 1 && num <= gmailAccounts.length) {
      accountsToAuth = [gmailAccounts[num - 1]];
    } else {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  let success = 0;
  let failed = 0;

  for (const account of accountsToAuth) {
    const refreshToken = await authGmailAccount(account.email);

    if (refreshToken) {
      // Encrypt and update
      const encrypted = encryptCredentials({ refresh_token: refreshToken });

      await pool.query(`
        UPDATE sender_accounts
        SET
          auth_type = 'oauth',
          credentials_encrypted = $1,
          credentials_iv = $2,
          credentials_tag = $3,
          status = 'active',
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $4
      `, [encrypted.encrypted, encrypted.iv, encrypted.tag, account.id]);

      console.log(`✅ Updated ${account.email}\n`);
      success++;
    } else {
      await pool.query(`
        UPDATE sender_accounts
        SET status = 'error', last_error = 'OAuth failed', last_error_at = NOW()
        WHERE id = $1
      `, [account.id]);
      failed++;
    }

    // Pause between accounts
    if (accountsToAuth.length > 1 && accountsToAuth.indexOf(account) < accountsToAuth.length - 1) {
      await question('\nPress Enter to continue to next account...');
    }
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`📊 Summary:`);
  console.log(`   ✅ Success: ${success}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log('');

  rl.close();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
