#!/usr/bin/env npx tsx

/**
 * Campaign Email Sender
 *
 * Sends personalized emails to campaign prospects with tracking.
 * Supports test mode to override recipients for safety.
 */

import { config } from 'dotenv';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createGmailClientFromEnv } from '../apps/campaigns/core/gmail-client.js';
import { getPool } from '../lib/database.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '..', 'templates', 'email');

const pool = getPool();

// SAFETY: Test mode overrides all recipients
const TEST_MODE = process.env.CAMPAIGN_TEST_MODE === 'true';
const TEST_RECIPIENT = process.env.CAMPAIGN_TEST_RECIPIENT || 'ryanrheger@gmail.com';

// Catch-all bounce protection
const CATCH_ALL_BOUNCE_THRESHOLD = parseFloat(process.env.CATCH_ALL_BOUNCE_THRESHOLD || '5'); // 5% default
const CATCH_ALL_MIN_SAMPLE_SIZE = parseInt(process.env.CATCH_ALL_MIN_SAMPLE_SIZE || '20'); // Need 20 sends before enforcing

interface Prospect {
  id: string;
  campaign_id: string;
  company_name: string;
  domain: string;
  contact_email: string;
  contact_name: string | null;
  critical_user_count: number;
  medium_user_count: number;
  total_eal_ml: number;
  tracking_token: string;
  status: string;
  critical_user_emails: string[] | null;
  medium_user_emails: string[] | null;
  metadata: Record<string, any> | null;
  is_catch_all: boolean;
}

interface BounceStats {
  email_type: string;
  total_sent: number;
  bounced: number;
  bounce_rate_pct: number;
}

interface Campaign {
  id: string;
  name: string;
  subject_template: string;
  body_template: string;
  from_name: string;
  from_email: string;
}

async function checkBounceRates(): Promise<{ verified: BounceStats | null; catchAll: BounceStats | null; catchAllPaused: boolean }> {
  const result = await pool.query<BounceStats>(`
    SELECT * FROM catch_all_bounce_stats
  `);

  let verified: BounceStats | null = null;
  let catchAll: BounceStats | null = null;

  for (const row of result.rows) {
    if (row.email_type === 'Verified') verified = row;
    if (row.email_type === 'Catch-All') catchAll = row;
  }

  // Determine if catch-all sending should be paused
  const catchAllPaused = catchAll !== null &&
    catchAll.total_sent >= CATCH_ALL_MIN_SAMPLE_SIZE &&
    catchAll.bounce_rate_pct > CATCH_ALL_BOUNCE_THRESHOLD;

  return { verified, catchAll, catchAllPaused };
}

async function lookupCatchAllStatus(email: string): Promise<boolean> {
  // Check if this email is from a catch-all domain based on campaign_contacts
  const result = await pool.query(`
    SELECT is_catch_all FROM campaign_contacts
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
  `, [email]);

  return result.rows.length > 0 && result.rows[0].is_catch_all === true;
}

async function sendCampaignEmails(campaignId: string, options: {
  batchSize?: number;
  dryRun?: boolean;
  testMode?: boolean;
}) {
  const { batchSize = 10, dryRun = false, testMode = TEST_MODE } = options;

  console.log('\n📧 Campaign Email Sender\n');

  if (testMode) {
    console.log('⚠️  TEST MODE ENABLED');
    console.log(`   All emails will be sent to: ${TEST_RECIPIENT}`);
    console.log('   To disable: unset CAMPAIGN_TEST_MODE or set to false\n');
  }

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No emails will actually be sent\n');
  }

  // 1. Load campaign
  console.log(`📋 Loading campaign: ${campaignId}`);
  const campaignResult = await pool.query<Campaign>(`
    SELECT id, name, subject_template, body_template, from_name, from_email
    FROM campaigns
    WHERE id = $1
  `, [campaignId]);

  if (campaignResult.rows.length === 0) {
    console.error(`❌ Campaign not found: ${campaignId}`);
    process.exit(1);
  }

  const campaign = campaignResult.rows[0];
  console.log(`✅ Campaign: ${campaign.name}\n`);

  // 2. Check bounce rates before loading prospects
  console.log('📊 Checking bounce rates...');
  const bounceStats = await checkBounceRates();

  if (bounceStats.verified) {
    console.log(`   Verified emails: ${bounceStats.verified.total_sent} sent, ${bounceStats.verified.bounce_rate_pct}% bounce rate`);
  }
  if (bounceStats.catchAll) {
    console.log(`   Catch-all emails: ${bounceStats.catchAll.total_sent} sent, ${bounceStats.catchAll.bounce_rate_pct}% bounce rate`);
  }

  if (bounceStats.catchAllPaused) {
    console.log(`\n⚠️  CATCH-ALL SENDING PAUSED`);
    console.log(`   Bounce rate (${bounceStats.catchAll!.bounce_rate_pct}%) exceeds threshold (${CATCH_ALL_BOUNCE_THRESHOLD}%)`);
    console.log(`   Only verified emails will be sent until bounce rate improves.`);
    console.log(`   To override: set CATCH_ALL_BOUNCE_THRESHOLD higher or investigate bounces.\n`);
  }

  // 3. Load prospects (queued status only, exclude STALE infostealer findings)
  console.log(`\n📊 Loading prospects (batch size: ${batchSize})...`);
  const prospectsResult = await pool.query<Prospect>(`
    SELECT
      p.id,
      p.campaign_id,
      COALESCE(l.query_params->>'company_name', p.company_name) as company_name,
      p.domain,
      p.contact_email,
      p.contact_name,
      p.critical_user_count,
      p.medium_user_count,
      p.total_eal_ml,
      p.tracking_token,
      p.status,
      p.critical_user_emails,
      p.medium_user_emails,
      p.metadata,
      COALESCE(p.is_catch_all, c.is_catch_all, false) as is_catch_all
    FROM campaign_prospects p
    LEFT JOIN campaign_contacts c ON LOWER(c.email) = LOWER(p.contact_email)
    LEFT JOIN lead_sources l ON l.domain = p.domain
    LEFT JOIN scans s ON s.id = p.scan_id
    WHERE p.campaign_id = $1
      AND p.status = 'queued'
      -- Exclude STALE infostealer findings (employees left company)
      AND NOT (
        COALESCE(p.metadata->>'campaign_type', '') = 'infostealer_credentials'
        AND s.finding_validation_status = 'stale'
      )
    ORDER BY p.total_eal_ml DESC NULLS LAST
    LIMIT $2
  `, [campaignId, batchSize]);

  const prospects = prospectsResult.rows;

  if (prospects.length === 0) {
    console.log('✅ No queued prospects to send to.\n');
    return;
  }

  console.log(`📬 Found ${prospects.length} prospects to contact\n`);

  // 3. Register Handlebars helpers and partials
  Handlebars.registerHelper('eq', function(a, b) {
    return a === b;
  });

  // Register opt-out footer partial
  try {
    const optOutFooter = readFileSync(join(TEMPLATES_DIR, '_opt_out_footer.hbs'), 'utf-8');
    Handlebars.registerPartial('_opt_out_footer', optOutFooter);
  } catch (err) {
    console.log('⚠️  Warning: Could not load _opt_out_footer.hbs partial');
  }

  // 4. Compile templates
  const subjectTemplate = Handlebars.compile(campaign.subject_template);
  const bodyTemplate = Handlebars.compile(campaign.body_template);

  // 4. Initialize Gmail client (only if not dry run)
  let gmailClient;
  if (!dryRun) {
    console.log('🔐 Initializing Gmail client...');
    gmailClient = createGmailClientFromEnv();
    await gmailClient.refreshAccessToken();
    console.log('✅ Gmail authenticated\n');
  }

  // 5. Send emails
  console.log('━'.repeat(80));
  console.log('📤 Sending emails...\n');

  let sent = 0;
  let failed = 0;
  let skippedCatchAll = 0;
  let sentCatchAll = 0;
  let sentVerified = 0;

  for (const prospect of prospects) {
    try {
      // Check if this is a catch-all email and if we should skip it
      const isCatchAll = prospect.is_catch_all;

      if (isCatchAll && bounceStats.catchAllPaused) {
        console.log(`⏭️  ${prospect.company_name} (${prospect.domain})`);
        console.log(`   Skipped: catch-all email, bounce rate too high\n`);
        skippedCatchAll++;
        continue;
      }

      // Helper to escape HTML in user-provided content
      const escapeHtml = (str: string) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      // Format email lists for template using <li> elements (max 5 shown)
      const MAX_EMAILS_SHOWN = 5;
      const criticalEmails = prospect.critical_user_emails || [];
      const criticalEmailsShown = criticalEmails.slice(0, MAX_EMAILS_SHOWN);
      const criticalEmailsRemaining = Math.max(0, criticalEmails.length - MAX_EMAILS_SHOWN);
      const criticalEmailsFormatted = criticalEmailsShown
        .map(email => `<li>${escapeHtml(email)}</li>`)
        .join('\n');

      const mediumEmailsFormatted = (prospect.medium_user_emails || [])
        .map(email => `<li>${escapeHtml(email)}</li>`)
        .join('\n');

      // Generate provenance line (randomized between two variants)
      const provenanceLine = Math.random() < 0.5
        ? 'I came across this while reviewing some security-related feeds for a client project and wanted to flag it for you, since this kind of information circulates widely once it shows up there.'
        : 'I noticed this in some security-focused feeds I was checking for a client project and thought it was worth flagging for you.';

      // Extract metadata fields (for WordPress, ADA, Email Security, Exposed Services campaigns)
      const meta = prospect.metadata || {};

      // Prepare template data
      const templateData = {
        // Common fields
        company_name: prospect.company_name,
        domain: prospect.domain,
        contact_name: prospect.contact_name || 'there',
        contact_email: prospect.contact_email,
        total_eal_ml: Math.round(prospect.total_eal_ml).toLocaleString(),
        from_name: campaign.from_name,
        tracking_token: prospect.tracking_token,
        provenance_line: provenanceLine,

        // Infostealer fields
        critical_user_count: prospect.critical_user_count,
        medium_user_count: prospect.medium_user_count,
        critical_user_emails: criticalEmailsFormatted,
        critical_emails_remaining: criticalEmailsRemaining,
        medium_user_emails: mediumEmailsFormatted,
        has_both_types: prospect.medium_user_count > 0,

        // WordPress fields (from metadata)
        wp_vuln_count: meta.wp_vuln_count || 0,
        wp_plugin_list: meta.wp_plugin_list || '',

        // ADA fields (from metadata)
        issue_count: meta.issue_count || 0,
        accessibility_issues: meta.accessibility_issues || '',

        // Email Security fields (from metadata)
        email_security_issues: meta.email_security_issues || '',
        missing_spf: meta.missing_spf || false,
        missing_dkim: meta.missing_dkim || false,
        missing_dmarc: meta.missing_dmarc || false,

        // Exposed Services fields (from metadata)
        service_count: meta.service_count || 0,
        exposed_services_list: meta.exposed_services_list || ''
      };

      // Compile subject and body
      const subject = subjectTemplate(templateData);
      const bodyHtml = bodyTemplate(templateData);

      // Body is already HTML (no need to convert newlines)
      const bodyHtmlFormatted = bodyHtml;

      // Determine recipient (test mode override)
      const actualRecipient = testMode ? TEST_RECIPIENT : prospect.contact_email;

      console.log(`📧 ${prospect.company_name} (${prospect.domain})${isCatchAll ? ' 🔄' : ''}`);
      console.log(`   To: ${actualRecipient}${isCatchAll ? ' (catch-all)' : ''}`);
      if (testMode && actualRecipient !== prospect.contact_email) {
        console.log(`   ⚠️  Original: ${prospect.contact_email} (overridden by test mode)`);
      }
      console.log(`   Subject: ${subject}`);
      console.log(`   Risk: $${Math.round(prospect.total_eal_ml).toLocaleString()}`);
      console.log(`   Token: ${prospect.tracking_token}`);

      if (dryRun) {
        console.log('   [DRY RUN - not actually sent]\n');
        continue;
      }

      // Send email
      const sentMessage = await gmailClient!.sendEmail({
        to: actualRecipient,
        subject: subject,
        bodyHtml: bodyHtmlFormatted,
        bodyText: bodyHtml, // Plain text version
        from: `${campaign.from_name} <${campaign.from_email}>`,
        replyTo: campaign.from_email,
        headers: {
          'X-Prospect-Token': prospect.tracking_token,
          'X-Campaign-ID': campaign.id,
          'X-Original-Recipient': prospect.contact_email // Track original for test mode
        }
      });

      // Record in database
      await pool.query(`
        INSERT INTO campaign_emails (
          prospect_id,
          campaign_id,
          direction,
          gmail_thread_id,
          gmail_message_id,
          subject,
          from_email,
          to_email,
          body_html,
          body_text,
          sent_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `, [
        prospect.id,
        campaign.id,
        'outbound',
        sentMessage.threadId || '',
        sentMessage.id || '',
        subject,
        campaign.from_email,
        actualRecipient,
        bodyHtmlFormatted,
        bodyHtml
      ]);

      // Record tracking event
      await pool.query(`
        INSERT INTO campaign_tracking (
          prospect_id,
          campaign_id,
          event_type,
          tracking_token,
          metadata
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        prospect.id,
        campaign.id,
        'email_sent',
        prospect.tracking_token,
        JSON.stringify({
          gmail_message_id: sentMessage.id,
          gmail_thread_id: sentMessage.threadId,
          test_mode: testMode,
          actual_recipient: actualRecipient,
          is_catch_all: isCatchAll
        })
      ]);

      // Update prospect status (include is_catch_all for tracking)
      await pool.query(`
        UPDATE campaign_prospects
        SET
          status = 'sent',
          gmail_thread_id = $2,
          gmail_message_id = $3,
          last_sent_at = NOW(),
          updated_at = NOW(),
          is_catch_all = $4
        WHERE id = $1
      `, [prospect.id, sentMessage.threadId, sentMessage.id, isCatchAll]);

      console.log('   ✅ Sent successfully\n');
      sent++;
      if (isCatchAll) {
        sentCatchAll++;
      } else {
        sentVerified++;
      }

      // Rate limiting: pause between sends
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds

    } catch (error: any) {
      console.error(`   ❌ Failed: ${error.message}\n`);
      failed++;
    }
  }

  console.log('━'.repeat(80));
  console.log('\n📊 Summary:');
  console.log(`   ✅ Sent: ${sent}`);
  console.log(`      - Verified: ${sentVerified}`);
  console.log(`      - Catch-all: ${sentCatchAll}`);
  console.log(`   ❌ Failed: ${failed}`);
  if (skippedCatchAll > 0) {
    console.log(`   ⏭️  Skipped (catch-all paused): ${skippedCatchAll}`);
  }
  console.log(`   📋 Total processed: ${prospects.length}\n`);

  // Show updated bounce stats
  const updatedStats = await checkBounceRates();
  if (updatedStats.verified || updatedStats.catchAll) {
    console.log('📈 Updated Bounce Stats:');
    if (updatedStats.verified) {
      console.log(`   Verified: ${updatedStats.verified.total_sent} sent, ${updatedStats.verified.bounce_rate_pct}% bounce rate`);
    }
    if (updatedStats.catchAll) {
      console.log(`   Catch-all: ${updatedStats.catchAll.total_sent} sent, ${updatedStats.catchAll.bounce_rate_pct}% bounce rate`);
      if (updatedStats.catchAllPaused) {
        console.log(`   ⚠️  Catch-all sending will be PAUSED next run (>${CATCH_ALL_BOUNCE_THRESHOLD}% threshold)`);
      }
    }
    console.log('');
  }

  if (testMode) {
    console.log('⚠️  Reminder: Test mode was enabled');
    console.log(`   All emails sent to: ${TEST_RECIPIENT}`);
    console.log('   Check your inbox to verify formatting!\n');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Campaign Email Sender - Send personalized emails to prospects

Usage:
  npm run campaign:send -- --campaign-id <ID> [options]

Required:
  --campaign-id <ID>      Campaign ID to send emails for

Options:
  --batch-size <number>   Number of emails to send (default: 10)
  --dry-run               Preview emails without sending
  --test-mode             Override all recipients with test email
  --test-recipient <email> Test mode recipient (default: ryanrheger@gmail.com)

Environment Variables:
  CAMPAIGN_TEST_MODE=true            Enable test mode (override recipients)
  CAMPAIGN_TEST_RECIPIENT=email      Test mode recipient email

Examples:
  # Dry run (preview only, no emails sent)
  npm run campaign:send -- --campaign-id campaign-123 --dry-run

  # Test mode (send all to test email)
  npm run campaign:send -- --campaign-id campaign-123 --test-mode --batch-size 2

  # Production mode (DANGER: sends to real prospects)
  npm run campaign:send -- --campaign-id campaign-123 --batch-size 10

Safety:
  - Default is TEST MODE (all emails go to ryanrheger@gmail.com)
  - Set CAMPAIGN_TEST_MODE=false to send to real prospects
  - Always do a dry run first!
    `);
    process.exit(0);
  }

  let campaignId = '';
  let batchSize = 10;
  let dryRun = false;
  let testMode = TEST_MODE;
  let testRecipient = TEST_RECIPIENT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--batch-size':
        batchSize = parseInt(next);
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--test-mode':
        testMode = true;
        break;
      case '--test-recipient':
        testRecipient = next;
        i++;
        break;
    }
  }

  if (!campaignId) {
    console.error('❌ Error: --campaign-id is required\n');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  // Override test recipient if provided
  if (testRecipient !== TEST_RECIPIENT) {
    process.env.CAMPAIGN_TEST_RECIPIENT = testRecipient;
  }

  try {
    await sendCampaignEmails(campaignId, { batchSize, dryRun, testMode });
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
