/**
 * fetch-opps.js
 *
 * Downloads the CMS OPPS Addendum B (quarterly file with Hospital Outpatient
 * Prospective Payment System rates per HCPCS/CPT code) and merges those rates
 * into the existing medicare_rates table.
 *
 * OPPS Addendum B gives the hospital facility fee Medicare pays for outpatient
 * services. Combined with the PFS facility_rate (the physician fee), this
 * approximates total Medicare payment for hospital outpatient procedures —
 * making negotiated rates apples-to-apples comparable to a Medicare benchmark.
 *
 * Data source: https://www.cms.gov/files/zip/january-2026-opps-addendum-b.zip
 *   (URL changes each quarter; check the parent quarterly-addenda-updates page)
 *
 * Wage index: Austin CBSA 12420 wage index applied to the labor share (60%)
 * of the OPPS payment. Hardcoded constant; refine when the FY 2026 wage table
 * is downloaded. National rate (factor=1.0) is the starting point.
 */

import { existsSync, mkdirSync, readFileSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'data');
const OPPS_DIR = path.join(DATA_DIR, 'opps');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'prices.db');

// Quarterly file — bump this and the URL when refreshing
const ADDENDUM_URL = 'https://www.cms.gov/files/zip/january-2026-opps-addendum-b.zip';
const ADDENDUM_ZIP = path.join(OPPS_DIR, 'january-2026-opps-addendum-b.zip');
const ADDENDUM_CSV_NAME = '2026 January Web Addendum B.12.29.25.csv';
const ADDENDUM_CSV = path.join(OPPS_DIR, ADDENDUM_CSV_NAME);

// CY 2026 OPPS labor/non-labor split. CMS publishes this in the OPPS final rule.
// payment = base × (LABOR_SHARE × wage_index + NON_LABOR_SHARE)
const LABOR_SHARE = 0.60;
const NON_LABOR_SHARE = 0.40;

// Austin-Round Rock-Georgetown (CBSA 12420) FY 2026 wage index.
// PLACEHOLDER: 1.00 = national unadjusted. Refine from CMS FY 2026 Table 3
// (Final Rule Wage Index by CBSA). Historical Austin values: ~0.97-1.00.
const AUSTIN_WAGE_INDEX = 1.00;

// Status indicators that produce a separate APC payment under OPPS.
// J1/J2 = Comprehensive APC; T/S/V = standard procedure payments;
// Q1/Q2/Q3 = STV-packaged or conditionally packaged (paid when separately payable);
// P/R/S1 = various separately-paid categories.
const PAYABLE_SI = new Set(['J1', 'J2', 'T', 'S', 'V', 'Q1', 'Q2', 'Q3', 'P', 'R', 'S1', 'U']);
// Status indicators that mean "no separate APC payment" — bundled or paid elsewhere.
const PACKAGED_SI = new Set(['N', 'Q4']);
const ALT_FEE_SCHEDULE_SI = new Set(['A']); // paid under another fee schedule (lab, mammography, etc.)
const INPATIENT_ONLY_SI = new Set(['C']);
const NOT_PAID_SI = new Set(['B', 'E1', 'E2', 'F', 'G', 'H', 'L']);

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`  Saved to ${dest}`);
}

function unzipCsv(zipPath, csvName, outDir) {
  execSync(`unzip -j -o "${zipPath}" "*${csvName}" -d "${outDir}"`, { stdio: 'pipe' });
  console.log(`  Extracted ${csvName}`);
}

function cleanPayment(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseAddendumB(csvPath) {
  const raw = readFileSync(csvPath, 'utf-8');
  // First 5 lines are disclaimer/header text; row 6 is the column header
  const lines = raw.split(/\r?\n/);
  const dataPortion = lines.slice(5).join('\n');
  const rows = parse(dataPortion, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`  Parsed ${rows.length} HCPCS rows`);
  return rows.map(r => ({
    code: (r['HCPCS Code'] || '').trim(),
    si: (r['SI'] || '').trim(),
    apc: (r['APC'] || '').trim(),
    relative_weight: cleanPayment(r['Relative Weight']),
    base_payment: cleanPayment(r['Payment Rate']),
  })).filter(r => r.code);
}

function applyWageIndex(basePayment) {
  if (basePayment == null) return null;
  const factor = LABOR_SHARE * AUSTIN_WAGE_INDEX + NON_LABOR_SHARE;
  return Math.round(basePayment * factor * 100) / 100;
}

function seedDatabase(records) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Add OPPS columns to medicare_rates if they don't exist yet.
  const existingCols = new Set(
    db.prepare(`PRAGMA table_info(medicare_rates)`).all().map(r => r.name)
  );
  const newCols = [
    ['apc_code', 'TEXT'],
    ['opps_status_indicator', 'TEXT'],
    ['opps_relative_weight', 'REAL'],
    ['opps_base_payment', 'REAL'],
    ['opps_austin_payment', 'REAL'],
    ['opps_quarter', 'TEXT'],
  ];
  for (const [name, type] of newCols) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE medicare_rates ADD COLUMN ${name} ${type}`);
      console.log(`  Added column medicare_rates.${name}`);
    }
  }

  const update = db.prepare(`
    UPDATE medicare_rates
       SET apc_code = ?,
           opps_status_indicator = ?,
           opps_relative_weight = ?,
           opps_base_payment = ?,
           opps_austin_payment = ?,
           opps_quarter = ?
     WHERE code = ?
  `);
  const insert = db.prepare(`
    INSERT INTO medicare_rates (code, apc_code, opps_status_indicator,
      opps_relative_weight, opps_base_payment, opps_austin_payment, opps_quarter)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let updated = 0, inserted = 0;
  const tx = db.transaction(() => {
    for (const r of records) {
      const austinPay = applyWageIndex(r.base_payment);
      const result = update.run(
        r.apc || null, r.si || null, r.relative_weight,
        r.base_payment, austinPay, '2026Q1', r.code
      );
      if (result.changes === 0) {
        try {
          insert.run(r.code, r.apc || null, r.si || null, r.relative_weight,
            r.base_payment, austinPay, '2026Q1');
          inserted++;
        } catch {}
      } else {
        updated++;
      }
    }
  });
  tx();

  console.log(`  Updated ${updated} existing rows, inserted ${inserted} new rows`);

  // Sanity checks
  const samples = ['70553', '45380', '27447', '93306', '52000'];
  console.log('\nSample APC payments:');
  for (const code of samples) {
    const r = db.prepare(`
      SELECT code, facility_rate, apc_code, opps_status_indicator,
             opps_base_payment, opps_austin_payment
      FROM medicare_rates WHERE code = ?
    `).get(code);
    if (!r) { console.log(`  ${code}: NOT FOUND`); continue; }
    const total = (r.facility_rate ?? 0) + (r.opps_austin_payment ?? 0);
    const si = (r.opps_status_indicator || '-').padEnd(3);
    const apc = (r.apc_code || '-').padEnd(6);
    console.log(
      `  ${code} SI=${si} APC=${apc} ` +
      `PFS=$${(r.facility_rate ?? 0).toFixed(2)} OPPS=$${(r.opps_austin_payment ?? 0).toFixed(2)} ` +
      `Total≈$${total.toFixed(2)}`
    );
  }

  db.close();
}

async function main() {
  if (!existsSync(OPPS_DIR)) mkdirSync(OPPS_DIR, { recursive: true });

  if (!existsSync(ADDENDUM_ZIP)) {
    await downloadFile(ADDENDUM_URL, ADDENDUM_ZIP);
  } else {
    console.log(`Using cached ${ADDENDUM_ZIP}`);
  }

  if (!existsSync(ADDENDUM_CSV)) {
    unzipCsv(ADDENDUM_ZIP, ADDENDUM_CSV_NAME, OPPS_DIR);
  }

  console.log('Parsing OPPS Addendum B...');
  const records = parseAddendumB(ADDENDUM_CSV);

  console.log(`\nWage adjustment: factor = ${LABOR_SHARE} × ${AUSTIN_WAGE_INDEX} + ${NON_LABOR_SHARE} = ${(LABOR_SHARE * AUSTIN_WAGE_INDEX + NON_LABOR_SHARE).toFixed(4)}`);
  console.log('Seeding database...');
  seedDatabase(records);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
