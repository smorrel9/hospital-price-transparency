/**
 * fetch-medicare.js
 *
 * Downloads the CMS Physician Fee Schedule RVU file and GPCI data,
 * calculates Austin-specific Medicare rates per CPT/HCPCS code,
 * and seeds them into a medicare_rates table in the existing SQLite DB.
 *
 * Data source: CMS PFS Relative Value Files (RVU26A)
 * Formula: Payment = [(Work RVU × Work GPCI) + (PE RVU × PE GPCI) + (MP RVU × MP GPCI)] × CF
 */

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'prices.db');
const ZIP_URL = 'https://www.cms.gov/files/zip/rvu26a.zip';
const ZIP_PATH = path.join(DATA_DIR, 'rvu26a.zip');

// Austin, TX — Medicare Locality 31, MAC 04412
const AUSTIN_LOCALITY = {
  mac: '04412',
  state: 'TX',
  locality: '31',
  name: 'AUSTIN',
  work_gpci: 1.002,
  pe_gpci: 1.058,
  mp_gpci: 0.886,
};

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);
  console.log(`  Saved to ${dest}`);
}

async function unzipFile(zipPath, targetFiles, outDir) {
  // Use native unzip command
  const { execSync } = await import('child_process');
  execSync(`unzip -o "${zipPath}" ${targetFiles.join(' ')} -d "${outDir}"`, { stdio: 'pipe' });
  console.log(`  Extracted: ${targetFiles.join(', ')}`);
}

function parseRvuCsv(content) {
  const lines = content.split('\n');

  // Find the header row (starts with "HCPCS,MOD,DESCRIPTION")
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('HCPCS,MOD,')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('Could not find RVU header row');

  const headers = lines[headerIdx].split(',');
  console.log(`  Found ${headers.length} columns, data starts at line ${headerIdx + 2}`);

  // Column indices (0-based)
  const COL = {
    hcpcs: 0,
    mod: 1,
    description: 2,
    status: 3,
    work_rvu: 5,
    nonfac_pe_rvu: 6,
    facility_pe_rvu: 8,
    mp_rvu: 10,
    nonfac_total: 11,
    facility_total: 12,
    conv_factor: 25,
  };

  const records = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV split (these files don't have quoted commas in data fields)
    const cols = line.split(',');
    const hcpcs = cols[COL.hcpcs]?.trim();
    if (!hcpcs) continue;

    const mod = cols[COL.mod]?.trim() || '';
    // Skip modifier rows (26=professional, TC=technical) — keep global (no modifier)
    if (mod === '26' || mod === 'TC') continue;

    const status = cols[COL.status]?.trim();
    // Status A = Active, R = Restricted, T = Injections, X = Statutory exclusion
    // Only include codes that Medicare actually pays for
    if (!['A', 'R', 'T'].includes(status)) continue;

    const work_rvu = parseFloat(cols[COL.work_rvu]) || 0;
    const nonfac_pe_rvu = parseFloat(cols[COL.nonfac_pe_rvu]) || 0;
    const facility_pe_rvu = parseFloat(cols[COL.facility_pe_rvu]) || 0;
    const mp_rvu = parseFloat(cols[COL.mp_rvu]) || 0;
    const conv_factor = parseFloat(cols[COL.conv_factor]) || 33.4009;
    const description = cols[COL.description]?.trim() || '';

    records.push({
      hcpcs,
      description,
      status,
      work_rvu,
      nonfac_pe_rvu,
      facility_pe_rvu,
      mp_rvu,
      conv_factor,
    });
  }

  return records;
}

function calculateAustinRates(records, gpci) {
  return records.map(r => {
    // Facility rate (hospital setting)
    const facility_rate =
      ((r.work_rvu * gpci.work_gpci) +
       (r.facility_pe_rvu * gpci.pe_gpci) +
       (r.mp_rvu * gpci.mp_gpci)) * r.conv_factor;

    // Non-facility rate (office/clinic setting)
    const nonfac_rate =
      ((r.work_rvu * gpci.work_gpci) +
       (r.nonfac_pe_rvu * gpci.pe_gpci) +
       (r.mp_rvu * gpci.mp_gpci)) * r.conv_factor;

    return {
      code: r.hcpcs,
      description: r.description,
      facility_rate: Math.round(facility_rate * 100) / 100,
      nonfac_rate: Math.round(nonfac_rate * 100) / 100,
      work_rvu: r.work_rvu,
      facility_pe_rvu: r.facility_pe_rvu,
      nonfac_pe_rvu: r.nonfac_pe_rvu,
      mp_rvu: r.mp_rvu,
      conv_factor: r.conv_factor,
    };
  });
}

function seedDatabase(rates) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create the medicare_rates table
  db.exec(`
    DROP TABLE IF EXISTS medicare_rates;
    CREATE TABLE medicare_rates (
      code TEXT PRIMARY KEY,
      description TEXT,
      facility_rate REAL,
      nonfac_rate REAL,
      work_rvu REAL,
      facility_pe_rvu REAL,
      nonfac_pe_rvu REAL,
      mp_rvu REAL,
      conv_factor REAL,
      locality TEXT DEFAULT 'Austin, TX',
      year INTEGER DEFAULT 2026
    );
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO medicare_rates
    (code, description, facility_rate, nonfac_rate, work_rvu, facility_pe_rvu, nonfac_pe_rvu, mp_rvu, conv_factor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(
        r.code, r.description, r.facility_rate, r.nonfac_rate,
        r.work_rvu, r.facility_pe_rvu, r.nonfac_pe_rvu, r.mp_rvu, r.conv_factor
      );
    }
  });

  tx(rates);
  console.log(`  Seeded ${rates.length} Medicare rates into ${DB_PATH}`);

  // Sanity check
  const sample = db.prepare(`SELECT * FROM medicare_rates WHERE code = '70553'`).get();
  if (sample) {
    console.log(`  Sample — 70553 (Brain MRI): facility=$${sample.facility_rate}, non-facility=$${sample.nonfac_rate}`);
  }
  const sample2 = db.prepare(`SELECT * FROM medicare_rates WHERE code = '27447'`).get();
  if (sample2) {
    console.log(`  Sample — 27447 (Total Knee): facility=$${sample2.facility_rate}, non-facility=$${sample2.nonfac_rate}`);
  }

  db.close();
}

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: Download
  if (!existsSync(ZIP_PATH)) {
    await downloadFile(ZIP_URL, ZIP_PATH);
  } else {
    console.log(`Using cached ${ZIP_PATH}`);
  }

  // Step 2: Extract
  const rvuFile = 'PPRRVU2026_Jan_nonQPP.csv';
  const rvuPath = path.join(DATA_DIR, rvuFile);
  if (!existsSync(rvuPath)) {
    await unzipFile(ZIP_PATH, [rvuFile], DATA_DIR);
  }

  // Step 3: Parse
  console.log('Parsing RVU data...');
  const content = await readFile(rvuPath, 'utf-8');
  const records = parseRvuCsv(content);
  console.log(`  Parsed ${records.length} procedure codes`);

  // Step 4: Calculate Austin rates
  console.log('Calculating Austin, TX Medicare rates...');
  console.log(`  GPCI: Work=${AUSTIN_LOCALITY.work_gpci}, PE=${AUSTIN_LOCALITY.pe_gpci}, MP=${AUSTIN_LOCALITY.mp_gpci}`);
  console.log(`  Conversion factor: $${records[0]?.conv_factor || 33.4009}`);
  const rates = calculateAustinRates(records, AUSTIN_LOCALITY);

  // Step 5: Seed DB
  console.log('Seeding database...');
  seedDatabase(rates);

  console.log('\nDone! Medicare rates are ready.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
