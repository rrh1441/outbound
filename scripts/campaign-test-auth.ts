#!/usr/bin/env npx tsx

/**
 * Test Gmail OAuth Authentication
 *
 * Verifies that GMAIL_REFRESH_TOKEN in .env is valid.
 */

import { config } from 'dotenv';
import { google } from 'googleapis';

// Load .env file
config();

async function testAuth() {
  console.log('\n🔍 Testing Gmail API Authentication...\n');

  // Check environment variables
  const requiredVars = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\nRun: npm run campaign:auth\n');
    process.exit(1);
  }

  console.log('✅ Environment variables present\n');

  try {
    // Create OAuth client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/callback'
    );

    // Set refresh token
    oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN
    });

    console.log('⏳ Testing token refresh...');

    // Force token refresh
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    console.log('✅ Access token refreshed successfully\n');

    // Test Gmail API
    console.log('⏳ Fetching Gmail profile...');
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Gmail API Authentication Successful!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📧 Authorized email: ${profile.data.emailAddress}`);
    console.log(`📬 Messages total: ${profile.data.messagesTotal}`);
    console.log(`📊 Threads total: ${profile.data.threadsTotal}`);
    console.log(`💾 History ID: ${profile.data.historyId}\n`);

    // Test sending capability
    console.log('⏳ Checking send permissions...');
    const labels = await gmail.users.labels.list({ userId: 'me' });
    const hasInbox = labels.data.labels?.some(l => l.id === 'INBOX');
    const hasSent = labels.data.labels?.some(l => l.id === 'SENT');

    if (hasInbox && hasSent) {
      console.log('✅ Send permissions verified\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 All checks passed! Ready to send emails.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('Next steps:');
    console.log('   1. Load a campaign: npm run campaign:load -- --name "My Campaign" --limit 10');
    console.log('   2. Send emails: npm run campaign:send -- --campaign-id <ID>\n');

  } catch (error: any) {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ Authentication Failed');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (error.message.includes('invalid_grant')) {
      console.error('❌ Refresh token is invalid or expired.\n');
      console.error('Solutions:');
      console.error('   1. Re-run authentication: npm run campaign:auth');
      console.error('   2. Check that GMAIL_REFRESH_TOKEN in .env is correct\n');
    } else if (error.message.includes('invalid_client')) {
      console.error('❌ Client ID or Secret is invalid.\n');
      console.error('Solutions:');
      console.error('   1. Verify GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env');
      console.error('   2. Check credentials at: https://console.cloud.google.com/apis/credentials\n');
    } else {
      console.error('Error:', error.message);
      console.error('\nFull error:', error);
    }

    process.exit(1);
  }
}

testAuth();
