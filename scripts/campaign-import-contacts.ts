#!/usr/bin/env npx tsx

/**
 * Import enriched contacts from CSV
 *
 * CSV format: domain,contact_name,contact_email,contact_title
 */

import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { getPool } from '../lib/database.js';

config();

// Use shared database configuration (Supabase takes priority)
const pool = getPool();

function parseCSV(csvContent: string): any[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row: any = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

async function importContacts(campaignId: string, csvPath: string, dryRun: boolean = false) {
  console.log('\n📥 Import Enriched Contacts\n');

  if (dryRun) {
    console.log('🧪 DRY RUN MODE\n');
  }

  // Load CSV
  console.log(`📂 Reading CSV: ${csvPath}`);
  const csvContent = readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(csvContent);

  console.log(`📊 Found ${rows.length} contacts\n`);

  if (rows.length === 0) {
    console.log('❌ No data to import');
    process.exit(1);
  }

  // Update prospects
  let updated = 0;
  let notFound = 0;

  for (const row of rows) {
    const { domain, contact_name, contact_email, contact_title } = row;

    if (!domain || !contact_email) {
      console.log(`⚠️  Skipping row - missing domain or email`);
      continue;
    }

    console.log(`📧 ${domain} → ${contact_name} <${contact_email}> (${contact_title || 'N/A'})`);

    if (!dryRun) {
      const result = await pool.query(`
        UPDATE campaign_prospects
        SET
          contact_email = $2,
          contact_name = $3,
          contact_title = $4,
          updated_at = NOW()
        WHERE campaign_id = $1 AND domain = $5
      `, [campaignId, contact_email, contact_name, contact_title || null, domain]);

      if (result.rowCount === 0) {
        console.log(`   ⚠️  No prospect found for domain: ${domain}`);
        notFound++;
      } else {
        console.log(`   ✅ Updated`);
        updated++;
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Updated: ${updated}`);
  console.log(`   ⚠️  Not found: ${notFound}`);
  console.log(`   📋 Total: ${rows.length}\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Import Enriched Contacts - Update prospect contacts from CSV

Usage:
  npm run campaign:import -- --campaign-id <ID> --csv <file> [--dry-run]

CSV Format:
  domain,contact_name,contact_email,contact_title
  example.com,John Smith,john@example.com,CTO
  acme.com,Jane Doe,jane@acme.com,CISO

Example:
  npm run campaign:import -- --campaign-id campaign-123 --csv contacts.csv --dry-run
    `);
    process.exit(0);
  }

  let campaignId = '';
  let csvPath = '';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--campaign-id':
        campaignId = next;
        i++;
        break;
      case '--csv':
        csvPath = next;
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  if (!campaignId || !csvPath) {
    console.error('❌ Error: --campaign-id and --csv are required\n');
    process.exit(1);
  }

  try {
    await importContacts(campaignId, csvPath, dryRun);
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
