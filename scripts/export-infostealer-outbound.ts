#!/usr/bin/env npx tsx

/**
 * Export Infostealer Findings for Outbound Campaigns
 *
 * Creates a CSV with:
 * - Company domain
 * - Scan ID
 * - CRITICAL users (infostealer malware - device infection)
 * - MEDIUM users (regular password leaks - split from CRITICAL)
 * - User counts for each severity
 * - Sources for each type
 */

import { writeFileSync } from 'fs';
import { getPool } from '../lib/database.js';

const pool = getPool();

function escapeCSV(value: string | number): string {
  if (typeof value === 'number') return value.toString();
  if (!value) return '';
  const stringValue = value.toString();
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

interface OutboundRecord {
  domain: string;
  company_name: string;
  scan_id: string;
  scan_date: string;
  critical_user_count: number;
  critical_users: string;
  critical_sources: string;
  medium_user_count: number;
  medium_users: string;
  medium_sources: string;
  medium_timeline: string;
  has_both_types: string;
  total_affected_users: number;
}

async function exportInfostealerFindings() {
  console.log('🔄 Exporting infostealer findings for outbound...\n');

  // Get all scans with CRITICAL findings (migrated)
  const result = await pool.query(`
    WITH critical_findings AS (
      SELECT
        s.id as scan_id,
        s.domain,
        s.metadata->>'company_name' as company_name,
        s.created_at::date as scan_date,
        f.description as critical_description
      FROM scans s
      JOIN findings f ON f.scan_id = s.id
      WHERE f.type = 'CRITICAL_BREACH_EXPOSURE'
        AND f.data->>'migration_info' IS NOT NULL
    ),
    medium_split_findings AS (
      SELECT
        f.scan_id,
        f.description as medium_description,
        f.data->'migration_info'->>'original_finding_id' as original_finding_id
      FROM findings f
      WHERE f.type = 'PASSWORD_BREACH_EXPOSURE'
        AND f.data->'migration_info'->>'created_from_split' = 'true'
    )
    SELECT
      c.domain,
      c.company_name,
      c.scan_id,
      c.scan_date,
      c.critical_description,
      m.medium_description
    FROM critical_findings c
    LEFT JOIN medium_split_findings m ON m.scan_id = c.scan_id
    ORDER BY c.scan_date DESC, c.domain
  `);

  console.log(`📊 Found ${result.rows.length} scans with infostealer findings\n`);

  const records: OutboundRecord[] = [];

  for (const row of result.rows) {
    // Parse CRITICAL finding description
    const criticalMatch = row.critical_description.match(/(\d+) critical breach exposures found: ([^|]+)/);
    const criticalSourcesMatch = row.critical_description.match(/Sources: ([^|]+)/);

    let criticalUsers = '';
    let criticalUserCount = 0;
    let criticalSources = '';

    if (criticalMatch) {
      criticalUserCount = parseInt(criticalMatch[1]);
      criticalUsers = criticalMatch[2].trim();
    }

    if (criticalSourcesMatch) {
      criticalSources = criticalSourcesMatch[1].trim();
    }

    // Parse MEDIUM finding description (if exists - split from CRITICAL)
    let mediumUsers = '';
    let mediumUserCount = 0;
    let mediumSources = '';
    let mediumTimeline = '';

    if (row.medium_description) {
      const mediumMatch = row.medium_description.match(/(\d+) medium breach exposures found: ([^|]+)/);
      const mediumSourcesMatch = row.medium_description.match(/Sources: ([^|]+?)(\s*\||$)/);
      const mediumTimelineMatch = row.medium_description.match(/Timeline: ([^|]+?)(\s*$)/);

      if (mediumMatch) {
        mediumUserCount = parseInt(mediumMatch[1]);
        mediumUsers = mediumMatch[2].trim();
      }

      if (mediumSourcesMatch) {
        mediumSources = mediumSourcesMatch[1].trim();
      }

      if (mediumTimelineMatch) {
        mediumTimeline = mediumTimelineMatch[1].trim();
      }
    }

    // Calculate unique users (some appear in both CRITICAL and MEDIUM)
    const criticalUserList = criticalUsers.split(',').map(u => u.trim().split(' ')[0]);
    const mediumUserList = mediumUsers ? mediumUsers.split(',').map(u => u.trim().split(' ')[0]) : [];
    const allUsers = new Set([...criticalUserList, ...mediumUserList]);

    records.push({
      domain: row.domain,
      company_name: row.company_name || '',
      scan_id: row.scan_id,
      scan_date: row.scan_date,
      critical_user_count: criticalUserCount,
      critical_users: criticalUsers,
      critical_sources: criticalSources,
      medium_user_count: mediumUserCount,
      medium_users: mediumUsers,
      medium_sources: mediumSources,
      medium_timeline: mediumTimeline,
      has_both_types: mediumUserCount > 0 ? 'YES' : 'NO',
      total_affected_users: allUsers.size
    });
  }

  // Write CSV manually
  const headers = [
    'Domain',
    'Company Name',
    'Scan Date',
    'CRITICAL Users (Infostealer)',
    'CRITICAL User Emails',
    'CRITICAL Sources (Malware)',
    'MEDIUM Users (Password Leaks)',
    'MEDIUM User Emails',
    'MEDIUM Sources (Databases)',
    'MEDIUM Timeline',
    'Has Both Types?',
    'Total Unique Users',
    'Scan ID'
  ];

  const csvLines = [headers.join(',')];

  for (const record of records) {
    const row = [
      escapeCSV(record.domain),
      escapeCSV(record.company_name),
      escapeCSV(record.scan_date),
      record.critical_user_count,
      escapeCSV(record.critical_users),
      escapeCSV(record.critical_sources),
      record.medium_user_count,
      escapeCSV(record.medium_users),
      escapeCSV(record.medium_sources),
      escapeCSV(record.medium_timeline),
      record.has_both_types,
      record.total_affected_users,
      escapeCSV(record.scan_id)
    ];
    csvLines.push(row.join(','));
  }

  writeFileSync('infostealer-outbound.csv', csvLines.join('\n'), 'utf-8');

  console.log('✅ Export complete!\n');
  console.log(`📄 File: infostealer-outbound.csv`);
  console.log(`📊 Total records: ${records.length}`);
  console.log(`   - With ONLY infostealer (CRITICAL): ${records.filter(r => !r.medium_users).length}`);
  console.log(`   - With BOTH types (CRITICAL + MEDIUM): ${records.filter(r => r.medium_users).length}`);

  // Summary statistics
  const totalCriticalUsers = records.reduce((sum, r) => sum + r.critical_user_count, 0);
  const totalMediumUsers = records.reduce((sum, r) => sum + r.medium_user_count, 0);
  const companiesWithBoth = records.filter(r => r.medium_users).length;

  console.log(`\n📈 User Statistics:`);
  console.log(`   - Total CRITICAL users (infostealer): ${totalCriticalUsers}`);
  console.log(`   - Total MEDIUM users (password leaks): ${totalMediumUsers}`);
  console.log(`   - Companies with both types: ${companiesWithBoth} (${Math.round(companiesWithBoth / records.length * 100)}%)`);

  await pool.end();
}

exportInfostealerFindings().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
