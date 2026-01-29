#!/usr/bin/env npx tsx

/**
 * Gmail OAuth Authentication Setup
 *
 * One-time interactive script to obtain Gmail API refresh token.
 * Saves the token to .env for use by email sender and sync workers.
 */

import { config } from 'dotenv';
import { createServer } from 'http';
import { parse } from 'url';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { google } from 'googleapis';
import * as readline from 'readline';

// Load .env file
config();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

function getCredentials(): OAuthCredentials {
  // Try .env first
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) {
    return {
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI
    };
  }

  // Try gmail-credentials.json
  try {
    const content = readFileSync('gmail-credentials.json', 'utf-8');
    const data = JSON.parse(content);

    if (data.installed) {
      return {
        client_id: data.installed.client_id,
        client_secret: data.installed.client_secret,
        redirect_uri: REDIRECT_URI
      };
    }

    if (data.web) {
      return {
        client_id: data.web.client_id,
        client_secret: data.web.client_secret,
        redirect_uri: REDIRECT_URI
      };
    }
  } catch (error) {
    // File doesn't exist, continue
  }

  throw new Error(`
❌ Gmail OAuth credentials not found!

Please do one of the following:

1. Add credentials to .env:
   GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   GMAIL_CLIENT_SECRET="your-client-secret"

2. Download credentials from Google Cloud Console and save as:
   gmail-credentials.json

See GMAIL_SETUP.md for detailed instructions.
  `);
}

async function authenticateInteractive() {
  console.log('\n🔐 Gmail OAuth Authentication Setup\n');

  const credentials = getCredentials();
  console.log('✅ OAuth credentials loaded\n');

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    credentials.redirect_uri
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account consent', // Force account picker AND consent screen
    login_hint: process.env.GMAIL_FROM_EMAIL // Pre-fill email if provided
  });

  console.log('📋 Step 1: Authorize this app by visiting this URL:\n');
  console.log('━'.repeat(80));
  console.log(authUrl);
  console.log('━'.repeat(80));
  console.log('\n📝 Instructions:');
  console.log('   1. Open the URL above in your browser');
  console.log('   2. Sign in with your Gmail account');
  console.log('   3. Click "Advanced" if you see a warning');
  console.log('   4. Click "Go to SimplCyber Campaign Mailer (unsafe)"');
  console.log('   5. Click "Allow" to grant permissions');
  console.log('   6. Copy the ENTIRE redirect URL from your browser');
  console.log('   7. Paste it below\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<void>((resolve, reject) => {
    rl.question('📎 Paste the redirect URL here: ', async (redirectUrl) => {
      rl.close();

      try {
        // Extract code from URL
        const parsedUrl = parse(redirectUrl, true);
        const code = parsedUrl.query.code as string;

        if (!code) {
          throw new Error('No authorization code found in URL. Make sure you copied the full redirect URL.');
        }

        console.log('\n⏳ Exchanging authorization code for tokens...');

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
          throw new Error('No refresh token received. Try running the script again.');
        }

        console.log('✅ Tokens received!\n');

        // Test the token
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });

        console.log(`📧 Authenticated as: ${profile.data.emailAddress}`);
        console.log(`📬 Total messages: ${profile.data.messagesTotal}\n`);

        // Save refresh token to .env
        const envPath = '.env';
        let envContent = '';

        try {
          envContent = readFileSync(envPath, 'utf-8');
        } catch (error) {
          // .env doesn't exist, create it
        }

        // Remove old GMAIL_REFRESH_TOKEN if exists
        const lines = envContent.split('\n').filter(line => !line.startsWith('GMAIL_REFRESH_TOKEN='));

        // Add new token
        lines.push(`GMAIL_REFRESH_TOKEN="${tokens.refresh_token}"`);

        writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');

        console.log('✅ Refresh token saved to .env\n');
        console.log('🎉 Authentication complete! You can now send emails.\n');
        console.log('Next steps:');
        console.log('   1. Verify: npm run campaign:test-auth');
        console.log('   2. Send emails: npm run campaign:send -- --campaign-id YOUR_CAMPAIGN_ID\n');

        resolve();
      } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        reject(error);
      }
    });
  });
}

async function main() {
  try {
    await authenticateInteractive();
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Authentication failed:', error.message);
    process.exit(1);
  }
}

main();
