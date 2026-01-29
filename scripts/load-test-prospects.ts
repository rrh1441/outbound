#!/usr/bin/env npx tsx

/**
 * Load Test Prospects - 5 of Each Campaign Type
 */

import { config } from 'dotenv';
import { randomBytes } from 'crypto';
import { getPool } from '../lib/database.js';

config();

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

function generateTrackingToken(): string {
  return randomBytes(16).toString('hex');
}

const CAMPAIGNS = [
  {
    type: 'infostealer_credentials',
    name: 'Test - Infostealer',
    subject: 'Security notice: {{company_name}} credentials exposed in malware logs',
    template: 'infostealer-high-impact.hbs'
  },
  {
    type: 'wordpress',
    name: 'Test - WordPress',
    subject: 'Security notice: {{wp_vuln_count}} vulnerable WordPress plugins on {{domain}}',
    template: 'wordpress-vulnerabilities.hbs'
  },
  {
    type: 'email_security',
    name: 'Test - Email Security',
    subject: 'Email security gap: {{domain}} is vulnerable to spoofing',
    template: 'email-security.hbs'
  },
  {
    type: 'direct_scan',
    name: 'Test - ADA Accessibility',
    subject: 'ADA/WCAG accessibility gaps identified on {{domain}}',
    template: 'ada-accessibility.hbs'
  },
  {
    type: 'qualified_scan',
    name: 'Test - Exposed Services',
    subject: 'Security issue: exposed services detected on {{domain}}',
    template: 'exposed-services.hbs'
  }
];

async function loadTestProspects() {
  console.log('\n🧪 Loading Test Prospects (5 of each type)\n');

  const campaignIds: string[] = [];

  for (const cfg of CAMPAIGNS) {
    console.log(`━━━ ${cfg.name} ━━━`);

    const campaignId = `campaign-test-${cfg.type.replace('_', '-')}-${Date.now()}`;

    // Store template_file reference instead of full template content
    // Templates are loaded from disk at send time for easy updates
    await pool.query(`
      INSERT INTO campaigns (id, name, status, subject_template, body_template, template_file, from_name, from_email, created_at)
      VALUES ($1, $2, 'active', $3, '', $4, $5, $6, NOW())
    `, [campaignId, cfg.name, cfg.subject, cfg.template, 'Ryan Heger', 'ryan@simplcyber-report.com']);

    campaignIds.push(campaignId);

    // Get 5 contacts
    const contacts = await pool.query(`
      SELECT cc.company_name, cc.domain, cc.email, cc.first_name, cc.is_catch_all, s.id as scan_id
      FROM campaign_contacts cc
      JOIN scans s ON REPLACE(s.domain, 'www.', '') = REPLACE(cc.domain, 'www.', '')
      WHERE cc.campaign_type = $1 AND cc.email IS NOT NULL AND s.status = 'completed'
      LIMIT 5
    `, [cfg.type]);

    for (const c of contacts.rows) {
      let metadata: any = {};
      let criticalEmails: string[] = [];
      let criticalCount = 0;

      if (cfg.type === 'infostealer_credentials') {
        const res = await pool.query(`
          SELECT jsonb_agg(DISTINCT r->>'email') as emails, COUNT(DISTINCT r->>'email')::int as cnt
          FROM artifacts a, jsonb_array_elements(a.metadata->'breach_analysis'->'leakcheck_results') r
          WHERE a.scan_id = $1 AND a.type = 'breach_directory_summary' AND r->'source'->>'name' = 'Stealer Logs'
        `, [c.scan_id]);
        criticalEmails = res.rows[0]?.emails || [];
        criticalCount = res.rows[0]?.cnt || 0;
      } else if (cfg.type === 'wordpress') {
        const res = await pool.query(`SELECT COUNT(*)::int as cnt FROM findings WHERE scan_id = $1 AND type = 'WP_PLUGIN_VULNERABILITY'`, [c.scan_id]);
        metadata.wp_vuln_count = res.rows[0]?.cnt || 2;
        metadata.wp_plugin_list = '<li>Contact Form 7 v5.4 - SQL Injection (CVE-2023-1234)</li><li>Elementor v3.6 - XSS vulnerability (CVE-2023-5678)</li>';
      } else if (cfg.type === 'email_security') {
        metadata.email_security_issues = '<li>SPF record: Missing or too permissive</li><li>DKIM: Not configured</li><li>DMARC: No policy set (p=none or missing)</li>';
      } else if (cfg.type === 'direct_scan') {
        metadata.accessibility_issues = '<li>12 images missing alt text</li><li>4 instances of low contrast text</li><li>Form inputs without associated labels</li><li>Missing skip navigation link</li>';
        metadata.issue_count = 19;
      } else if (cfg.type === 'qualified_scan') {
        metadata.exposed_services_list = '<li>MySQL (port 3306) - publicly accessible without VPN</li><li>Redis (port 6379) - no authentication required</li>';
        metadata.service_count = 2;
      }

      await pool.query(`
        INSERT INTO campaign_prospects (
          id, campaign_id, scan_id, company_name, domain, contact_email, contact_name,
          critical_user_count, critical_user_emails, medium_user_count, medium_user_emails,
          total_eal_ml, tracking_token, status, is_catch_all, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, '{}', 0, $10, 'queued', $11, $12, NOW(), NOW())
        ON CONFLICT (campaign_id, scan_id) DO NOTHING
      `, [
        `prospect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        campaignId, c.scan_id, c.company_name, c.domain, c.email, c.first_name,
        criticalCount, criticalEmails, generateTrackingToken(), c.is_catch_all || false, JSON.stringify(metadata)
      ]);

      console.log(`  ✅ ${c.company_name} (${c.email})`);
    }
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📋 Campaign IDs created:\n');
  for (const id of campaignIds) {
    console.log(`  ${id}`);
  }
  console.log('\n🚀 To send ALL test emails to yourself:\n');
  console.log('for id in ' + campaignIds.join(' ') + '; do');
  console.log('  CAMPAIGN_TEST_MODE=true npm run campaign:schedule -- --campaign-id $id --force');
  console.log('done\n');
}

async function main() {
  try {
    await loadTestProspects();
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
