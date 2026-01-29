#!/usr/bin/env npx tsx

/**
 * Campaign Loader
 *
 * Loads prospects from infostealer CSV exports into campaign tables.
 * Links prospects to existing scans and enriches with EAL data.
 */

import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { getPool } from '../lib/database.js';

const pool = getPool();

interface CSVRow {
  Domain: string;
  'Company Name': string;
  'Scan Date': string;
  'CRITICAL Users (Infostealer)': string;
  'CRITICAL User Emails': string;
  'CRITICAL Sources (Malware)': string;
  'MEDIUM Users (Password Leaks)': string;
  'MEDIUM User Emails': string;
  'MEDIUM Sources (Databases)': string;
  'MEDIUM Timeline': string;
  'Has Both Types?': string;
  'Total Unique Users': string;
  'Scan ID': string;
}

interface CampaignConfig {
  name: string;
  description?: string;
  csvPath: string;
  minEal?: number;
  targetSegment?: string;
  limit?: number;
  subjectTemplate?: string;
  bodyTemplate?: string;
  fromName?: string;
  fromEmail?: string;
}

function generateTrackingToken(): string {
  return randomBytes(16).toString('hex');
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current); // Add last field
  return result;
}

function parseCSV(csvContent: string): CSVRow[] {
  const lines = csvContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: CSVRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: any = {};

    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });

    rows.push(row as CSVRow);
  }

  return rows;
}

async function createCampaign(config: CampaignConfig): Promise<string> {
  console.log(`\n📋 Creating campaign: ${config.name}\n`);

  // 1. Create campaign record
  const campaignResult = await pool.query(`
    INSERT INTO campaigns (
      name,
      description,
      campaign_type,
      status,
      target_segment,
      min_eal_threshold,
      subject_template,
      body_template,
      from_name,
      from_email
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
    config.name,
    config.description || `Infostealer outreach campaign targeting companies with credential exposure`,
    'infostealer_credentials',
    'draft',
    config.targetSegment || 'all',
    config.minEal || 0,
    config.subjectTemplate || 'Security Alert: Credential exposure detected at {{company_name}}',
    config.bodyTemplate || 'Hi {{contact_name}},\n\nI noticed that {{company_name}} has {{critical_user_count}} employees whose credentials were found in recent infostealer malware logs.\n\n{{#if has_both_types}}\nAdditionally, {{medium_user_count}} employees appeared in password database leaks.\n{{/if}}\n\nThis represents approximately ${{total_eal_ml}} in annual cybersecurity risk.\n\nI\'ve prepared a detailed security assessment report. Would you have 15 minutes this week to review?\n\nBest regards,\n{{from_name}}',
    config.fromName || 'Ryan Heger',
    config.fromEmail || process.env.GMAIL_FROM_EMAIL || 'ryan@simplcyber.com'
  ]);

  const campaignId = campaignResult.rows[0].id;
  console.log(`✅ Campaign created: ${campaignId}\n`);

  // 2. Load CSV and parse
  console.log(`📂 Loading CSV: ${config.csvPath}`);
  const csvContent = readFileSync(config.csvPath, 'utf-8');
  const rows = parseCSV(csvContent);
  console.log(`📊 Found ${rows.length} rows in CSV\n`);

  // 3. Deduplicate by scan_id (CSV has duplicates)
  const uniqueScans = new Map<string, CSVRow>();
  rows.forEach(row => {
    if (!uniqueScans.has(row['Scan ID'])) {
      uniqueScans.set(row['Scan ID'], row);
    }
  });

  console.log(`🔍 Found ${uniqueScans.size} unique scans\n`);

  // 4. Enrich with EAL data and filter
  let loaded = 0;
  let skipped = 0;
  const limit = config.limit || Infinity;

  for (const [scanId, row] of uniqueScans) {
    if (loaded >= limit) {
      console.log(`⏸️  Reached limit of ${limit} prospects`);
      break;
    }

    // Lookup EAL from scan_eal_summary view
    const ealResult = await pool.query(`
      SELECT total_eal_ml FROM scan_eal_summary WHERE scan_id = $1
    `, [scanId]);

    const totalEalMl = ealResult.rows[0]?.total_eal_ml || 0;

    // Apply EAL filter
    if (config.minEal && totalEalMl < config.minEal) {
      skipped++;
      continue;
    }

    // Apply segment filter
    const hasBothTypes = row['Has Both Types?'] === 'YES';
    if (config.targetSegment === 'both_types' && !hasBothTypes) {
      skipped++;
      continue;
    }
    if (config.targetSegment === 'infostealer_only' && hasBothTypes) {
      skipped++;
      continue;
    }

    // Parse contact email (use first CRITICAL user email)
    const criticalEmails = row['CRITICAL User Emails'].split(',').map(e => e.trim());
    const contactEmail = criticalEmails[0] || 'unknown@example.com';

    // Extract risk categories from sources
    const topRiskCategories: string[] = [];
    if (row['CRITICAL Users (Infostealer)'] !== '0') {
      topRiskCategories.push('BREACH_INFOSTEALER');
    }
    if (row['MEDIUM Users (Password Leaks)'] !== '0') {
      topRiskCategories.push('BREACH_PASSWORD');
    }

    try {
      // Parse affected email lists
      const criticalEmails = row['CRITICAL User Emails']
        .split(',')
        .map(e => e.trim())
        .filter(e => e && e !== '');

      const mediumEmails = row['MEDIUM User Emails']
        ? row['MEDIUM User Emails'].split(',').map(e => e.trim()).filter(e => e && e !== '')
        : [];

      // Insert prospect
      await pool.query(`
        INSERT INTO campaign_prospects (
          campaign_id,
          scan_id,
          company_name,
          domain,
          contact_email,
          contact_name,
          critical_user_count,
          medium_user_count,
          total_eal_ml,
          top_risk_categories,
          tracking_token,
          status,
          critical_user_emails,
          medium_user_emails
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (campaign_id, scan_id) DO NOTHING
      `, [
        campaignId,
        scanId,
        row['Company Name'],
        row.Domain,
        contactEmail,
        null, // contact_name - we'll enrich this later
        parseInt(row['CRITICAL Users (Infostealer)']) || 0,
        parseInt(row['MEDIUM Users (Password Leaks)']) || 0,
        totalEalMl,
        topRiskCategories,
        generateTrackingToken(),
        'queued',
        criticalEmails,
        mediumEmails
      ]);

      loaded++;

      if (loaded % 10 === 0) {
        process.stdout.write(`\r✨ Loaded ${loaded} prospects...`);
      }
    } catch (error: any) {
      console.error(`\n⚠️  Error loading ${row.Domain}: ${error.message}`);
    }
  }

  console.log(`\n\n✅ Campaign loading complete!\n`);
  console.log(`📊 Summary:`);
  console.log(`   - Campaign ID: ${campaignId}`);
  console.log(`   - Prospects loaded: ${loaded}`);
  console.log(`   - Prospects skipped: ${skipped}`);

  // 5. Show campaign stats
  const statsResult = await pool.query(`
    SELECT * FROM campaign_performance WHERE campaign_id = $1
  `, [campaignId]);

  if (statsResult.rows.length > 0) {
    const stats = statsResult.rows[0];
    console.log(`\n💰 Campaign Financial Impact:`);
    console.log(`   - Total addressable risk: $${stats.total_addressable_risk_ml?.toLocaleString() || 0}`);
    console.log(`   - Average risk per prospect: $${stats.avg_risk_per_prospect_ml?.toLocaleString() || 0}`);
    console.log(`\n👥 Exposure Summary:`);
    console.log(`   - Total CRITICAL users: ${stats.total_critical_users || 0}`);
    console.log(`   - Total MEDIUM users: ${stats.total_medium_users || 0}`);
  }

  // 6. Sample prospects
  console.log(`\n📋 Sample prospects (first 5):\n`);
  const sampleResult = await pool.query(`
    SELECT
      company_name,
      domain,
      contact_email,
      critical_user_count,
      medium_user_count,
      total_eal_ml,
      tracking_token
    FROM campaign_prospects
    WHERE campaign_id = $1
    ORDER BY total_eal_ml DESC NULLS LAST
    LIMIT 5
  `, [campaignId]);

  sampleResult.rows.forEach((row, idx) => {
    console.log(`${idx + 1}. ${row.company_name} (${row.domain})`);
    console.log(`   Email: ${row.contact_email}`);
    console.log(`   Risk: $${row.total_eal_ml?.toLocaleString() || 0} | CRITICAL: ${row.critical_user_count} | MEDIUM: ${row.medium_user_count}`);
    console.log(`   Token: ${row.tracking_token}\n`);
  });

  return campaignId;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Campaign Loader - Load prospects from CSV into campaign tracking

Usage:
  npm run campaign:load -- --name "Campaign Name" --csv path/to/file.csv [options]

Options:
  --name <string>         Campaign name (required)
  --csv <path>            Path to CSV file (default: infostealer-outbound.csv)
  --description <string>  Campaign description
  --min-eal <number>      Minimum EAL threshold (filter prospects)
  --target <segment>      Target segment: all, both_types, infostealer_only
  --limit <number>        Maximum prospects to load
  --subject <template>    Email subject template
  --from-name <name>      Sender name
  --from-email <email>    Sender email

Examples:
  # Load first 100 high-value prospects
  npm run campaign:load -- --name "Wave 1" --min-eal 5000 --limit 100

  # Load only companies with both infostealer + password leaks
  npm run campaign:load -- --name "High Risk" --target both_types

  # Load all prospects from custom CSV
  npm run campaign:load -- --name "All Prospects" --csv custom-export.csv
    `);
    process.exit(0);
  }

  const config: CampaignConfig = {
    name: '',
    csvPath: 'infostealer-outbound.csv'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--name':
        config.name = next;
        i++;
        break;
      case '--csv':
        config.csvPath = next;
        i++;
        break;
      case '--description':
        config.description = next;
        i++;
        break;
      case '--min-eal':
        config.minEal = parseFloat(next);
        i++;
        break;
      case '--target':
        config.targetSegment = next;
        i++;
        break;
      case '--limit':
        config.limit = parseInt(next);
        i++;
        break;
      case '--subject':
        config.subjectTemplate = next;
        i++;
        break;
      case '--from-name':
        config.fromName = next;
        i++;
        break;
      case '--from-email':
        config.fromEmail = next;
        i++;
        break;
    }
  }

  if (!config.name) {
    console.error('❌ Error: --name is required\n');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  try {
    await createCampaign(config);
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
