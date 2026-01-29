#!/usr/bin/env npx tsx
/**
 * Send test emails for notable infostealer contacts
 */

import { config } from 'dotenv';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool } from '../lib/database.js';

config();

const pool = getPool();
const INBOX_API_URL = process.env.INBOX_API_URL || 'http://localhost:3847';
const TEST_EMAIL = process.env.CAMPAIGN_TEST_RECIPIENT || process.env.TEST_EMAIL;
if (!TEST_EMAIL) {
  throw new Error('Set CAMPAIGN_TEST_RECIPIENT or TEST_EMAIL in .env');
}

const NOTABLE_DOMAINS = [
  'buffer.com'
  // 'loom.com',
  // 'ycombinator.com',
  // 'thomabravo.com',
  // 'truveta.com',
  // 'terracycle.com'
];

// Register Handlebars helper
Handlebars.registerHelper('eq', (a, b) => a === b);

// Register partial
Handlebars.registerPartial('_opt_out_footer', `
<p style="font-size: 11px; color: #666; margin-top: 30px;">
If you'd prefer not to receive these alerts, just reply "unsubscribe" and I'll remove you from future notifications.
</p>
`);

async function getNotableContacts() {
  const result = await pool.query(`
    SELECT
      c.domain,
      COALESCE(l.query_params->>'company_name', c.company_name) as company_name,
      c.first_name,
      c.email as contact_email,
      c.title,
      f.data->>'user_count' as user_count,
      f.description as finding_description
    FROM campaign_contacts c
    JOIN scans s ON s.id = c.scan_id
    JOIN findings f ON f.scan_id = s.id AND f.type = 'CRITICAL_BREACH_EXPOSURE'
    LEFT JOIN lead_sources l ON l.domain = c.domain
    WHERE c.domain = ANY($1)
      AND c.campaign_type = 'infostealer_credentials'
  `, [NOTABLE_DOMAINS]);
  return result.rows;
}

// Parse emails from finding description like:
// "8 critical breach exposures found: email1@domain.com, email2@domain.com and 3 more | ..."
function parseEmailsFromDescription(description: string): string[] {
  if (!description) return [];
  const match = description.match(/found: ([^|]+)/);
  if (!match) return [];

  let emailPart = match[1].trim();
  // Remove "and X more" suffix
  emailPart = emailPart.replace(/\s+and \d+ more$/, '');

  return emailPart.split(',').map(e => e.trim()).filter(e => e.includes('@'));
}

async function getSenderAccount() {
  const result = await pool.query(`
    SELECT * FROM sender_accounts WHERE status = 'active' LIMIT 1
  `);
  return result.rows[0];
}

function loadTemplate() {
  const templatePath = join(process.cwd(), 'templates/email/infostealer-high-impact.hbs');
  const source = readFileSync(templatePath, 'utf-8');
  return Handlebars.compile(source);
}

async function sendEmail(accountId: string, to: string, subject: string, bodyHtml: string) {
  const response = await fetch(`${INBOX_API_URL}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account_id: accountId,
      to,
      subject,
      body_html: bodyHtml,
      body_text: bodyHtml.replace(/<[^>]+>/g, '')
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Send failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function main() {
  console.log('🧪 Sending test emails for notable infostealer contacts\n');
  console.log(`📧 All emails will be sent to: ${TEST_EMAIL}\n`);

  const contacts = await getNotableContacts();
  const account = await getSenderAccount();
  const template = loadTemplate();

  if (!account) {
    console.error('❌ No active sender account found');
    await pool.end();
    return;
  }

  console.log(`📤 Using sender: ${account.email}\n`);

  for (const contact of contacts) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🏢 ${contact.company_name}`);
    console.log(`👤 ${contact.first_name} - ${contact.title}`);
    console.log(`📊 ${contact.user_count} compromised credentials`);

    // Parse actual emails from finding description
    const emails = parseEmailsFromDescription(contact.finding_description);
    console.log(`📧 Affected: ${emails.slice(0, 3).join(', ')}${emails.length > 3 ? ` +${emails.length - 3} more` : ''}`);

    // Build email list for template (show up to 5)
    const MAX_EMAILS_SHOWN = 5;
    const totalCount = parseInt(contact.user_count) || emails.length || 1;
    const emailsShown = emails.slice(0, MAX_EMAILS_SHOWN);
    const emailsRemaining = Math.max(0, totalCount - emailsShown.length);
    const emailsList = emailsShown.map((e: string) => `<li>${e}</li>`).join('');

    const data = {
      company_name: contact.company_name,
      critical_user_count: totalCount,
      critical_user_emails: emailsList,
      critical_emails_remaining: emailsRemaining
    };

    const bodyHtml = template(data);
    // Use real subject line format (no "Security alert:")
    const subject = `[TEST] ${contact.company_name} credentials in infostealer malware logs`;

    try {
      await sendEmail(account.id, TEST_EMAIL, subject, bodyHtml);
      console.log(`✅ Sent to ${TEST_EMAIL}\n`);

      // Small delay between sends
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}\n`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n✨ Done! Check ${TEST_EMAIL} for ${contacts.length} test emails.`);
  await pool.end();
}

main().catch(console.error);
