import { config } from 'dotenv';
import { Pool } from 'pg';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';

config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/scanner_local' });
const INBOX_API_URL = process.env.INBOX_API_URL || 'http://localhost:3847';
const TEST_EMAIL = 'ryanrheger@gmail.com';

// Get one queued prospect from each template type
async function getTestProspects() {
  const result = await pool.query(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY metadata->>'campaign_type' ORDER BY id) as rn
      FROM campaign_prospects 
      WHERE status = 'queued' AND metadata->>'campaign_type' IS NOT NULL
    )
    SELECT * FROM ranked WHERE rn = 1
    ORDER BY 
      CASE metadata->>'campaign_type'
        WHEN 'wordpress' THEN 1
        WHEN 'infostealer_credentials' THEN 2
        WHEN 'email_security' THEN 3
        WHEN 'ada_accessibility' THEN 4
      END
    LIMIT 4
  `);
  return result.rows;
}

// Get sender account
async function getSenderAccount() {
  const result = await pool.query(`
    SELECT * FROM sender_accounts WHERE status = 'active' LIMIT 1
  `);
  return result.rows[0];
}

// Load and compile template
function loadTemplate(templateType: string) {
  const templateMap: Record<string, string> = {
    'wordpress': 'wordpress-vulnerabilities.hbs',
    'infostealer_credentials': 'infostealer-high-impact.hbs',
    'email_security': 'email-security.hbs',
    'ada_accessibility': 'ada-accessibility.hbs'
  };
  const filename = templateMap[templateType];
  if (!filename) throw new Error(`Unknown template: ${templateType}`);
  
  const templatePath = join(process.cwd(), 'templates/email', filename);
  const source = readFileSync(templatePath, 'utf-8');
  return Handlebars.compile(source);
}

// Send via inbox API
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
  console.log('🧪 Sending test emails (one from each template)\n');
  
  const prospects = await getTestProspects();
  const account = await getSenderAccount();
  
  console.log(`📧 Using sender: ${account.email}\n`);
  
  for (const prospect of prospects) {
    const campaignType = prospect.metadata?.campaign_type;
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📋 Template: ${campaignType}`);
    console.log(`🏢 Company: ${prospect.company_name} (${prospect.domain})`);
    
    try {
      const template = loadTemplate(campaignType);
      
      // Build template data
      const data = {
        company_name: prospect.company_name,
        domain: prospect.domain,
        critical_user_count: prospect.critical_user_count,
        critical_user_emails: prospect.critical_user_emails?.join(', ') || '',
        medium_user_count: prospect.medium_user_count,
        wp_plugin_list: prospect.metadata?.wp_plugin_list || '',
        wp_vuln_count: prospect.metadata?.wp_vuln_count || 0,
        email_security_issues: prospect.metadata?.email_security_issues || '',
        accessibility_issues: prospect.metadata?.accessibility_issues || ''
      };
      
      const bodyHtml = template(data);
      const subject = `[TEST] ${campaignType} template for ${prospect.domain}`;
      
      console.log(`📨 Sending to: ${TEST_EMAIL}`);
      console.log(`📝 Subject: ${subject}`);
      
      await sendEmail(account.id, TEST_EMAIL, subject, bodyHtml);
      console.log(`✅ Sent successfully!\n`);
      
      // Small delay between sends
      await new Promise(r => setTimeout(r, 2000));
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}\n`);
    }
  }
  
  console.log('✨ Done! Check ryanrheger@gmail.com for test emails.');
  await pool.end();
}

main().catch(console.error);
