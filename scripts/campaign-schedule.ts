#!/usr/bin/env npx tsx

/**
 * Scheduled Campaign Email Sender
 *
 * Sends campaign emails on a schedule using Microsoft accounts.
 * Designed for warmup period with conservative sending limits.
 *
 * Features:
 * - Uses multiple sender accounts (rotates between them)
 * - Random delays between emails (10-20 minutes)
 * - Respects sending window (8am-11:50am ET)
 * - Daily limits per account (5-10 emails)
 * - Test mode support
 */

import { config } from 'dotenv';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool, getDatabaseUrl, isSupabase } from '../lib/database.js';
import { CAMPAIGN_TYPES, escapeHtml } from '../lib/campaigns/email.js';

// SenderAccount interface (matches what's in the database)
interface SenderAccount {
  id: string;
  email: string;
  display_name: string | null;
  provider: 'gmail' | 'microsoft';
  auth_type: 'oauth' | 'password';
  status: 'active' | 'paused' | 'error';
  daily_limit: number;
  emails_sent_today: number;
  last_sent_at?: Date | string | null;
}

// Inbox API configuration - uses local server
// SECURITY: Validate URL to prevent SSRF attacks
function validateInboxApiUrl(url: string): string {
  const parsed = new URL(url);
  const allowedHosts = ['localhost', '127.0.0.1'];
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new Error(`INBOX_API_URL must be localhost for security. Got: ${parsed.hostname}`);
  }
  return url;
}
const INBOX_API_URL = validateInboxApiUrl(process.env.INBOX_API_URL || 'http://localhost:3847');

// Send email via inbox-web API
async function sendEmailViaApi(account: SenderAccount, options: {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}): Promise<{ messageId: string }> {
  const response = await fetch(`${INBOX_API_URL}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account_id: account.id,
      to: options.to,
      subject: options.subject,
      body_html: options.bodyHtml,
      body_text: options.bodyText || options.bodyHtml.replace(/<[^>]*>/g, '')
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  const result = await response.json();
  return { messageId: result.message_id || '' };
}

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '..', 'templates', 'email');

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

// SAFETY: Test mode overrides all recipients
const TEST_MODE = process.env.CAMPAIGN_TEST_MODE !== 'false';
const TEST_RECIPIENT = process.env.CAMPAIGN_TEST_RECIPIENT || 'ryanrheger@gmail.com';

// OUTREACH FILTER: Only send to high-value finding types
// Set ALLOWED_CAMPAIGN_TYPES env var to comma-separated list, or use defaults from shared module
// Set OUTBOUND_ENABLED=false to disable all outbound
const OUTBOUND_ENABLED = process.env.OUTBOUND_ENABLED !== 'false';
const ALLOWED_CAMPAIGN_TYPES = process.env.ALLOWED_CAMPAIGN_TYPES
  ? process.env.ALLOWED_CAMPAIGN_TYPES.split(',').map(s => s.trim())
  : [...CAMPAIGN_TYPES];

// Schedule configuration
const SCHEDULE_CONFIG = {
  // Sending window (Eastern Time)
  startHour: 8,        // 8:00 AM ET
  endHour: 11,         // End before noon
  endMinute: 30,       // 11:30 AM ET

  // Per-account daily limits (6 per inbox for warmup)
  minEmailsPerDay: 6,
  maxEmailsPerDay: 6,

  // Delay between emails (minutes)
  minDelayMinutes: 10,
  maxDelayMinutes: 20,

  // Sender accounts loaded dynamically from DB (enabled_for_sending = true)
  senderAccounts: [] as string[]
};

interface ProspectMetadata {
  campaign_type?: string;
  notification_type?: string;
  wp_vuln_count?: number;
  wp_plugin_list?: string;
  issue_count?: number;
  accessibility_issues?: string;
  email_security_issues?: string;
  missing_spf?: boolean;
  missing_dkim?: boolean;
  missing_dmarc?: boolean;
  service_count?: number;
  exposed_services_list?: string;
}

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
  metadata: ProspectMetadata | null;
  is_catch_all: boolean;
  sender_email: string | null;
}

interface Campaign {
  id: string;
  name: string;
  subject_template: string;
  body_template: string;
  from_name: string;
  from_email: string;
}

interface ScheduledEmail {
  prospect: Prospect;
  scheduledTime: Date;
  senderAccount: SenderAccount;
}

/**
 * Get current time in Eastern Time
 */
function getEasternTime(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/**
 * Check if current time is within sending window
 */
function isWithinSendingWindow(): boolean {
  const et = getEasternTime();
  const hour = et.getHours();
  const minute = et.getMinutes();

  if (hour < SCHEDULE_CONFIG.startHour) return false;
  if (hour > SCHEDULE_CONFIG.endHour) return false;
  if (hour === SCHEDULE_CONFIG.endHour && minute > SCHEDULE_CONFIG.endMinute) return false;

  return true;
}

/**
 * Get random integer between min and max (inclusive)
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Get random delay in milliseconds
 */
function getRandomDelayMs(): number {
  const minutes = randomInt(SCHEDULE_CONFIG.minDelayMinutes, SCHEDULE_CONFIG.maxDelayMinutes);
  // Add some seconds variation for more natural timing
  const seconds = randomInt(0, 59);
  return (minutes * 60 + seconds) * 1000;
}

/**
 * Get random daily limit for an account
 */
function getRandomDailyLimit(): number {
  return randomInt(SCHEDULE_CONFIG.minEmailsPerDay, SCHEDULE_CONFIG.maxEmailsPerDay);
}

/**
 * Load sender accounts from database (uses enabled_for_sending flag)
 */
async function loadSenderAccounts(): Promise<SenderAccount[]> {
  const result = await pool.query<SenderAccount>(`
    SELECT *
    FROM sender_accounts
    WHERE status = 'active'
      AND provider = 'microsoft'
      AND enabled_for_sending = true
    ORDER BY email
  `);

  // Update config with loaded accounts for reference
  SCHEDULE_CONFIG.senderAccounts = result.rows.map(r => r.email);

  return result.rows;
}

/**
 * Get remaining send capacity for an account today
 * Counts ACTUAL sends today from campaign_prospects, not a counter
 */
async function getRemainingCapacity(accountEmail: string): Promise<number> {
  // Get the daily limit
  const limitResult = await pool.query(`
    SELECT daily_limit FROM sender_accounts WHERE email = $1
  `, [accountEmail]);

  if (limitResult.rows.length === 0) return 0;
  const daily_limit = limitResult.rows[0].daily_limit;

  // Count actual sends today (not a counter that can get out of sync)
  const sentResult = await pool.query(`
    SELECT COUNT(*) as sent_today
    FROM campaign_prospects
    WHERE sender_email = $1
      AND status = 'sent'
      AND last_sent_at >= CURRENT_DATE
      AND last_sent_at < CURRENT_DATE + INTERVAL '1 day'
  `, [accountEmail]);

  const sent_today = parseInt(sentResult.rows[0].sent_today, 10);
  return Math.max(0, daily_limit - sent_today);
}

/**
 * Increment send count for an account
 */
async function incrementSendCount(accountEmail: string): Promise<void> {
  await pool.query(`
    UPDATE sender_accounts
    SET
      emails_sent_today = emails_sent_today + 1,
      emails_sent_total = emails_sent_total + 1,
      last_sent_at = NOW(),
      updated_at = NOW()
    WHERE email = $1
  `, [accountEmail]);
}

/**
 * Calculate time remaining in today's sending window
 */
function getMinutesRemainingInWindow(): number {
  const et = getEasternTime();
  const hour = et.getHours();
  const minute = et.getMinutes();

  if (!isWithinSendingWindow()) return 0;

  const endMinutes = SCHEDULE_CONFIG.endHour * 60 + SCHEDULE_CONFIG.endMinute;
  const currentMinutes = hour * 60 + minute;

  return endMinutes - currentMinutes;
}

/**
 * Run scheduled campaign sending
 */
async function runScheduledSend(campaignId: string, options: {
  dryRun?: boolean;
  testMode?: boolean;
  maxEmails?: number;
  force?: boolean;
}) {
  const { dryRun = false, testMode = TEST_MODE, maxEmails, force = false } = options;

  console.log('\n📅 Scheduled Campaign Sender\n');
  console.log(`⏰ Current time (ET): ${getEasternTime().toLocaleString()}`);

  // Check if outbound is enabled
  if (!OUTBOUND_ENABLED) {
    console.log('\n🛑 OUTBOUND DISABLED');
    console.log('   Set OUTBOUND_ENABLED=true to resume sending.\n');
    return;
  }

  // Check sending window (unless force is set)
  if (!force && !isWithinSendingWindow()) {
    console.log(`\n⏸️  Outside sending window (${SCHEDULE_CONFIG.startHour}:00 AM - ${SCHEDULE_CONFIG.endHour}:${SCHEDULE_CONFIG.endMinute} AM ET)`);
    console.log('   Run this script during the sending window or use --force to override.\n');
    return;
  }

  const minutesRemaining = getMinutesRemainingInWindow();
  console.log(`⏱️  ${minutesRemaining} minutes remaining in today's window`);

  // Reset daily counters for accounts that haven't sent today
  const resetResult = await pool.query(`
    UPDATE sender_accounts
    SET emails_sent_today = 0
    WHERE last_sent_at::date < CURRENT_DATE
      AND emails_sent_today > 0
    RETURNING email
  `);
  if (resetResult.rowCount && resetResult.rowCount > 0) {
    console.log(`\n🔄 Reset daily counters for ${resetResult.rowCount} accounts`);
  }

  if (testMode) {
    console.log('\n⚠️  TEST MODE ENABLED');
    console.log(`   All emails will be sent to: ${TEST_RECIPIENT}`);
    console.log('   To disable: set CAMPAIGN_TEST_MODE=false\n');
  }

  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No emails will actually be sent\n');
  }

  // Load campaign
  console.log(`\n📋 Loading campaign: ${campaignId}`);
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

  // Load sender accounts
  console.log('📧 Loading sender accounts...');
  const senderAccounts = await loadSenderAccounts();

  if (senderAccounts.length === 0) {
    console.error('❌ No active sender accounts found');
    console.log('   Configure accounts with: npm run inbox:add-account');
    process.exit(1);
  }

  console.log(`✅ Found ${senderAccounts.length} active accounts:\n`);

  // Calculate capacity per account
  let totalCapacity = 0;
  const accountCapacity: Map<string, number> = new Map();

  // When --max-emails is set, ignore per-inbox limits and distribute evenly
  const useGlobalLimit = maxEmails !== undefined && maxEmails > 0;
  const perInboxAllocation = useGlobalLimit
    ? Math.ceil(maxEmails / senderAccounts.length)
    : undefined;

  for (const account of senderAccounts) {
    let effectiveCapacity: number;

    if (useGlobalLimit) {
      // Ignore per-inbox daily_limit, use global allocation
      effectiveCapacity = perInboxAllocation!;
      console.log(`   ${account.email}: allocated ${effectiveCapacity} (global limit mode)`);
    } else {
      // Use per-inbox limits
      const remaining = await getRemainingCapacity(account.email);
      const todayLimit = getRandomDailyLimit();
      effectiveCapacity = Math.min(remaining, todayLimit);
      console.log(`   ${account.email}: ${account.emails_sent_today}/${account.daily_limit} sent, ${effectiveCapacity} remaining for this run`);
    }

    accountCapacity.set(account.email, effectiveCapacity);
    totalCapacity += effectiveCapacity;
  }

  if (totalCapacity === 0 && !useGlobalLimit) {
    console.log('\n✅ All accounts have reached their daily limits.\n');
    return;
  }

  // Calculate effective limit - each inbox sends in parallel, only limited by per-inbox capacity
  // Time-based limit only matters for how many emails ONE inbox can send in the window
  const avgDelayMinutes = (SCHEDULE_CONFIG.minDelayMinutes + SCHEDULE_CONFIG.maxDelayMinutes) / 2;
  const maxPerInboxInWindow = Math.floor(minutesRemaining / avgDelayMinutes);
  const perInboxLimit = Math.min(SCHEDULE_CONFIG.maxEmailsPerDay, maxPerInboxInWindow);
  const effectiveLimit = useGlobalLimit
    ? maxEmails!
    : totalCapacity;

  console.log(`\n📊 Sending plan:`);
  console.log(`   Total capacity: ${totalCapacity} emails (${senderAccounts.length} inboxes × ${SCHEDULE_CONFIG.maxEmailsPerDay} each)`);
  console.log(`   Time allows: ${maxPerInboxInWindow} emails per inbox in ${minutesRemaining} min`);
  console.log(`   Effective limit: ${effectiveLimit} emails`);

  // Load prospects scheduled for today (filtered by allowed campaign types)
  console.log(`\n📊 Loading prospects scheduled for today...`);
  console.log(`🔍 Filtering to campaign types: ${ALLOWED_CAMPAIGN_TYPES.join(', ')}`);
  // For infostealer campaigns, exclude prospects with STALE findings
  // STALE = employees confirmed to have left the company
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
      COALESCE(p.is_catch_all, false) as is_catch_all,
      p.sender_email
    FROM campaign_prospects p
    LEFT JOIN lead_sources l ON l.domain = p.domain
    LEFT JOIN scans s ON s.id = p.scan_id
    WHERE p.campaign_id = $1
      AND p.status IN ('queued', 'sending')
      AND (p.scheduled_date IS NULL OR p.scheduled_date <= CURRENT_DATE)
      AND (
        COALESCE(p.metadata->>'campaign_type', p.metadata->>'notification_type', 'direct_scan') = ANY($3)
      )
      -- Exclude STALE infostealer findings (employees left company)
      AND NOT (
        COALESCE(p.metadata->>'campaign_type', '') = 'infostealer_credentials'
        AND s.finding_validation_status = 'stale'
      )
    ORDER BY COALESCE(p.is_catch_all, false) ASC, p.scheduled_date ASC NULLS LAST, p.total_eal_ml DESC NULLS LAST
    LIMIT $2
  `, [campaignId, effectiveLimit, ALLOWED_CAMPAIGN_TYPES]);

  const prospects = prospectsResult.rows;

  if (prospects.length === 0) {
    console.log('✅ No queued prospects to send to.\n');
    return;
  }

  console.log(`📬 Found ${prospects.length} prospects to contact\n`);

  // Register Handlebars helpers and partials
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

  // Template mapping for different campaign types
  const TEMPLATE_MAP: Record<string, { file: string; subject: string }> = {
    'nextjs_rsc': {
      file: 'nextjs-rsc.hbs',
      subject: 'Security notice – {{domain}} server component exposure'
    },
    'infostealer_credentials': {
      file: 'infostealer-high-impact.hbs',
      subject: '{{company_name}} credentials in infostealer malware logs'
    },
    'wordpress': {
      file: 'wordpress-vulnerabilities.hbs',
      subject: 'WordPress security notice for {{domain}}'
    },
    'ada_accessibility': {
      file: 'ada-accessibility.hbs',
      subject: 'ADA compliance notice for {{domain}}'
    },
    'email_security': {
      file: 'email-security.hbs',
      subject: 'Email authentication gaps for {{domain}}'
    },
    'exposed_services': {
      file: 'exposed-services.hbs',
      subject: 'Exposed services detected on {{domain}}'
    },
    'github_secrets': {
      file: 'github-secrets.hbs',
      subject: 'Exposed credentials found for {{company_name}}'
    },
    'direct_scan': {
      file: 'general-security.hbs',
      subject: 'Security findings for {{company_name}}'
    },
    'discovery_experiment': {
      file: 'general-security.hbs',
      subject: 'Security notice for {{company_name}}'
    }
  };

  // Load and compile all templates
  const compiledTemplates: Map<string, { subject: Handlebars.TemplateDelegate; body: Handlebars.TemplateDelegate }> = new Map();

  for (const [notificationType, config] of Object.entries(TEMPLATE_MAP)) {
    try {
      const bodySource = readFileSync(join(TEMPLATES_DIR, config.file), 'utf-8');
      compiledTemplates.set(notificationType, {
        subject: Handlebars.compile(config.subject),
        body: Handlebars.compile(bodySource)
      });
      console.log(`📄 Loaded template: ${config.file} (${notificationType})`);
    } catch (err) {
      console.error(`❌ Could not load template: ${config.file}`);
    }
  }

  // Fallback templates from campaign DB (for backwards compatibility)
  const fallbackSubjectTemplate = Handlebars.compile(campaign.subject_template || '{{company_name}} - Security Notice');
  const fallbackBodyTemplate = Handlebars.compile(campaign.body_template || '<p>Security notice for {{company_name}}</p>');

  // Build send schedule - respect pre-assignments, fallback to round-robin
  const schedule: ScheduledEmail[] = [];
  let accountIndex = 0;
  const accountsSentCount: Map<string, number> = new Map();

  for (const account of senderAccounts) {
    accountsSentCount.set(account.email, 0);
  }

  let preAssignedCount = 0;
  let roundRobinCount = 0;

  for (const prospect of prospects) {
    let assignedAccount: SenderAccount | undefined;

    // Check for pre-assigned sender
    if (prospect.sender_email) {
      assignedAccount = senderAccounts.find(a => a.email === prospect.sender_email);
      if (assignedAccount) {
        preAssignedCount++;
      } else {
        console.log(`   ⚠️ Pre-assigned sender ${prospect.sender_email} not available for ${prospect.domain}`);
      }
    }

    // Fallback to round-robin if no pre-assignment or assigned sender unavailable
    if (!assignedAccount) {
      let attempts = 0;
      while (attempts < senderAccounts.length) {
        const account = senderAccounts[accountIndex];
        const capacity = accountCapacity.get(account.email) || 0;
        const sent = accountsSentCount.get(account.email) || 0;

        if (sent < capacity) {
          assignedAccount = account;
          roundRobinCount++;
          break;
        }

        accountIndex = (accountIndex + 1) % senderAccounts.length;
        attempts++;
      }
      accountIndex = (accountIndex + 1) % senderAccounts.length;
    }

    if (assignedAccount) {
      const capacity = accountCapacity.get(assignedAccount.email) || 0;
      const sent = accountsSentCount.get(assignedAccount.email) || 0;

      if (sent < capacity) {
        schedule.push({
          prospect,
          scheduledTime: new Date(),
          senderAccount: assignedAccount
        });
        accountsSentCount.set(assignedAccount.email, sent + 1);
      }
    }
  }

  if (preAssignedCount > 0 || roundRobinCount > 0) {
    console.log(`\n📬 Assignment: ${preAssignedCount} pre-assigned, ${roundRobinCount} round-robin`);
  }

  console.log('━'.repeat(80));
  console.log('📤 Starting scheduled send...\n');

  // Send one email - returns true if sent, false if skipped/failed
  async function sendOneEmail(prospect: Prospect, senderAccount: SenderAccount): Promise<boolean> {
    const meta = prospect.metadata || {};
    const MAX_EMAILS_SHOWN = 5;
    const criticalEmails = prospect.critical_user_emails || [];
    const criticalEmailsShown = criticalEmails.slice(0, MAX_EMAILS_SHOWN);
    const criticalEmailsRemaining = Math.max(0, criticalEmails.length - MAX_EMAILS_SHOWN);
    const criticalEmailsFormatted = criticalEmailsShown
      .map((email: string) => `<li>${escapeHtml(email)}</li>`).join('\n');
    const mediumEmailsFormatted = (prospect.medium_user_emails || [])
      .map((email: string) => `<li>${escapeHtml(email)}</li>`).join('\n');

    const provenanceLine = Math.random() < 0.5
      ? 'I came across this while reviewing some security-related feeds for a client project and wanted to flag it for you, since this kind of information circulates widely once it shows up there.'
      : 'I noticed this in some security-focused feeds I was checking for a client project and thought it was worth flagging for you.';

    const templateData = {
      company_name: prospect.company_name,
      domain: prospect.domain,
      contact_name: prospect.contact_name || 'there',
      contact_email: prospect.contact_email,
      total_eal_ml: Math.round(prospect.total_eal_ml || 0).toLocaleString(),
      from_name: senderAccount.display_name || campaign.from_name,
      tracking_token: prospect.tracking_token,
      provenance_line: provenanceLine,
      critical_user_count: prospect.critical_user_count,
      medium_user_count: prospect.medium_user_count,
      critical_user_emails: criticalEmailsFormatted,
      critical_emails_remaining: criticalEmailsRemaining,
      medium_user_emails: mediumEmailsFormatted,
      has_both_types: prospect.medium_user_count > 0,
      wp_vuln_count: meta.wp_vuln_count || 0,
      wp_plugin_list: meta.wp_plugin_list || '',
      issue_count: meta.issue_count || 0,
      accessibility_issues: meta.accessibility_issues || '',
      email_security_issues: meta.email_security_issues || '',
      missing_spf: meta.missing_spf || false,
      missing_dkim: meta.missing_dkim || false,
      missing_dmarc: meta.missing_dmarc || false,
      service_count: meta.service_count || 0,
      exposed_services_list: meta.exposed_services_list || ''
    };

    const campaignType = meta.campaign_type || meta.notification_type || 'direct_scan';
    const templates = compiledTemplates.get(campaignType);
    const subject = templates ? templates.subject(templateData) : fallbackSubjectTemplate(templateData);
    const bodyHtml = templates ? templates.body(templateData) : fallbackBodyTemplate(templateData);
    const actualRecipient = testMode ? TEST_RECIPIENT : prospect.contact_email;

    console.log(`📧 ${senderAccount.email.split('@')[0]}: ${prospect.company_name} (${prospect.domain})`);
    console.log(`   To: ${actualRecipient} | Subject: ${subject.substring(0, 50)}...`);

    if (dryRun) {
      console.log('   [DRY RUN]\n');
      return false;
    }

    // Duplicate check - skip in test mode (always sends to same test email)
    if (!testMode) {
      const dupCheck = await pool.query(
        `SELECT id FROM inbox_messages WHERE to_email = $1 AND sent_at > NOW() - INTERVAL '24 hours' AND direction = 'outbound' LIMIT 1`,
        [actualRecipient]
      );
      if (dupCheck.rows.length > 0) {
        console.log('   ⚠️ SKIPPED - already emailed\n');
        await pool.query(`UPDATE campaign_prospects SET status = 'sent', updated_at = NOW() WHERE id = $1`, [prospect.id]);
        return false;
      }
    }

    // Mark as sending
    await pool.query(`UPDATE campaign_prospects SET status = 'sending', updated_at = NOW() WHERE id = $1`, [prospect.id]);

    // Send via API
    const result = await sendEmailViaApi(senderAccount, {
      to: actualRecipient,
      subject,
      bodyHtml,
      bodyText: bodyHtml.replace(/<[^>]*>/g, '')
    });

    // Mark as sent and store sender_email
    await pool.query(
      `UPDATE campaign_prospects SET status = 'sent', sender_email = $2, gmail_message_id = $3, last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [prospect.id, senderAccount.email, result.messageId || '']
    );

    // Record in campaign_emails (non-critical)
    try {
      await pool.query(
        `INSERT INTO campaign_emails (prospect_id, campaign_id, direction, gmail_message_id, gmail_thread_id, subject, from_email, to_email, body_html, body_text, sent_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [prospect.id, campaign.id, 'outbound', result.messageId || '', result.messageId || '', subject, senderAccount.email, actualRecipient, bodyHtml, bodyHtml.replace(/<[^>]*>/g, '')]
      );
    } catch (e) { /* ignore */ }

    // Tracking (non-critical)
    try {
      await pool.query(
        `INSERT INTO campaign_tracking (prospect_id, campaign_id, event_type, tracking_token, metadata) VALUES ($1, $2, $3, $4, $5)`,
        [prospect.id, campaign.id, 'email_sent', prospect.tracking_token, JSON.stringify({ message_id: result.messageId, sender: senderAccount.email })]
      );
    } catch (e) { /* ignore */ }

    await incrementSendCount(senderAccount.email);
    console.log('   ✅ Sent\n');
    return true;
  }

  // Group prospects by sender account
  const prospectsByAccount: Map<string, typeof schedule> = new Map();
  for (const item of schedule) {
    const email = item.senderAccount.email;
    if (!prospectsByAccount.has(email)) {
      prospectsByAccount.set(email, []);
    }
    prospectsByAccount.get(email)!.push(item);
  }

  let sent = 0;
  let failed = 0;
  let totalProcessed = 0;

  // Helper function to send emails for one account
  async function sendForAccount(accountEmail: string, items: typeof schedule, offsetMs: number) {
    // Initial offset so accounts don't all start at once
    if (offsetMs > 0) {
      console.log(`   ⏳ ${accountEmail}: starting in ${Math.round(offsetMs / 60000)} min\n`);
      await new Promise(resolve => setTimeout(resolve, offsetMs));
    }

    for (let i = 0; i < items.length; i++) {
      const { prospect, senderAccount } = items[i];

      // Check if still within window (unless force mode)
      if (!force && !isWithinSendingWindow()) {
        console.log(`\n⏸️  ${accountEmail}: Sending window ended. Stopping.\n`);
        break;
      }

      try {
        const didSend = await sendOneEmail(prospect, senderAccount);
        if (didSend) sent++;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`   ❌ ${accountEmail}: Failed - ${message}\n`);
        failed++;
      }
      totalProcessed++;

      // Wait before next email from this account (unless it's the last one)
      if (i < items.length - 1 && !dryRun) {
        const delayMs = testMode ? 3000 : getRandomDelayMs();
        const delayMins = Math.round(delayMs / 60000);
        console.log(`   ⏳ ${accountEmail}: next in ${delayMins} min\n`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // Start all accounts in parallel with staggered offsets (0, 1-3 min, 2-6 min, 3-9 min)
  const accountPromises: Promise<void>[] = [];
  let offsetIndex = 0;
  for (const [accountEmail, items] of prospectsByAccount) {
    const offsetMs = offsetIndex * (60000 + Math.random() * 120000); // 1-3 min offset per account
    console.log(`📬 ${accountEmail}: ${items.length} emails queued`);
    accountPromises.push(sendForAccount(accountEmail, items, offsetMs));
    offsetIndex++;
  }
  console.log('');

  // Wait for all accounts to finish
  await Promise.all(accountPromises);

  console.log('━'.repeat(80));
  console.log('\n📊 Summary:');
  console.log(`   ✅ Sent: ${sent}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📋 Total: ${schedule.length}\n`);

  // Show updated account stats
  console.log('📈 Account stats:');
  for (const email of SCHEDULE_CONFIG.senderAccounts) {
    const result = await pool.query(`
      SELECT emails_sent_today, daily_limit
      FROM sender_accounts
      WHERE email = $1
    `, [email]);

    if (result.rows.length > 0) {
      const { emails_sent_today, daily_limit } = result.rows[0];
      console.log(`   ${email}: ${emails_sent_today}/${daily_limit}`);
    }
  }
  console.log('');

  if (testMode) {
    console.log('⚠️  Reminder: Test mode was enabled');
    console.log(`   All emails sent to: ${TEST_RECIPIENT}\n`);
  }
}

/**
 * Show schedule status
 */
async function showStatus(campaignId: string) {
  console.log('\n📅 Schedule Status\n');

  const et = getEasternTime();
  console.log(`⏰ Current time (ET): ${et.toLocaleString()}`);
  console.log(`📆 Sending window: ${SCHEDULE_CONFIG.startHour}:00 AM - ${SCHEDULE_CONFIG.endHour}:${SCHEDULE_CONFIG.endMinute} AM ET`);
  console.log(`   Status: ${isWithinSendingWindow() ? '✅ Active' : '⏸️ Outside window'}`);

  if (isWithinSendingWindow()) {
    console.log(`   Remaining: ${getMinutesRemainingInWindow()} minutes`);
  }

  // Campaign info
  if (campaignId) {
    const campaignResult = await pool.query(`
      SELECT id, name, status,
        (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = campaigns.id AND status = 'queued') as queued,
        (SELECT COUNT(*) FROM campaign_prospects WHERE campaign_id = campaigns.id AND status = 'sent') as sent
      FROM campaigns WHERE id = $1
    `, [campaignId]);

    if (campaignResult.rows.length > 0) {
      const c = campaignResult.rows[0];
      console.log(`\n📋 Campaign: ${c.name}`);
      console.log(`   Status: ${c.status}`);
      console.log(`   Queued: ${c.queued}`);
      console.log(`   Sent: ${c.sent}`);
    }
  }

  // Account status
  console.log('\n📧 Sender Accounts:\n');
  const accounts = await loadSenderAccounts();

  for (const account of accounts) {
    const remaining = await getRemainingCapacity(account.email);
    console.log(`   ${account.email}`);
    console.log(`     Status: ${account.status}`);
    console.log(`     Sent today: ${account.emails_sent_today}/${account.daily_limit}`);
    console.log(`     Remaining: ${remaining}`);
    if (account.last_sent_at) {
      console.log(`     Last sent: ${new Date(account.last_sent_at).toLocaleString()}`);
    }
    console.log('');
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Scheduled Campaign Sender - Send emails with randomized timing

Usage:
  npm run campaign:schedule -- --campaign-id <ID> [options]

Required:
  --campaign-id <ID>     Campaign ID to send emails for

Options:
  --dry-run              Preview without sending
  --status               Show schedule and account status
  --max-emails <n>       Maximum emails to send this run
  --force                Override sending window check

Environment:
  OUTBOUND_ENABLED         Set to 'true' to enable sending (default: true)
  CAMPAIGN_TEST_MODE       Set to 'false' for production (default: true)
  CAMPAIGN_TEST_RECIPIENT  Test mode recipient
  ALLOWED_CAMPAIGN_TYPES   Comma-separated list of campaign types to send
                           (default: infostealer_credentials,wordpress)

Schedule Configuration (in script):
  Sending window: ${SCHEDULE_CONFIG.startHour}:00 AM - ${SCHEDULE_CONFIG.endHour}:${SCHEDULE_CONFIG.endMinute} AM ET
  Emails per account: ${SCHEDULE_CONFIG.minEmailsPerDay}-${SCHEDULE_CONFIG.maxEmailsPerDay}/day
  Delay between emails: ${SCHEDULE_CONFIG.minDelayMinutes}-${SCHEDULE_CONFIG.maxDelayMinutes} minutes

Sender accounts:
${SCHEDULE_CONFIG.senderAccounts.map(e => `  - ${e}`).join('\n')}

Examples:
  # Check status
  npm run campaign:schedule -- --campaign-id campaign-123 --status

  # Dry run (preview)
  npm run campaign:schedule -- --campaign-id campaign-123 --dry-run

  # Production (during sending window)
  CAMPAIGN_TEST_MODE=false npm run campaign:schedule -- --campaign-id campaign-123
    `);
    process.exit(0);
  }

  let campaignId = '';
  let dryRun = false;
  let showStatusOnly = false;
  let maxEmails: number | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--status':
        showStatusOnly = true;
        break;
      case '--max-emails':
        maxEmails = parseInt(next);
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (!campaignId) {
    console.error('❌ Error: --campaign-id is required\n');
    process.exit(1);
  }

  try {
    if (showStatusOnly) {
      await showStatus(campaignId);
    } else {
      await runScheduledSend(campaignId, { dryRun, maxEmails, force });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('\n❌ Fatal error:', message);
    if (stack) console.error(stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
