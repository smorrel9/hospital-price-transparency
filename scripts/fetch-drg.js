/**
 * fetch-drg.js
 *
 * Builds the Medicare inpatient (DRG-based) reference rates for our 4 Austin
 * hospitals using:
 *   - CMS-1833-F Table 5 — MS-DRG relative weights for FY 2026
 *   - FY 2026 IPPS Impact File — per-hospital wage index, IME, and DSH factors
 *   - FY 2026 Federal Standardized Amount (operating) and labor share
 *
 * Computes per-(DRG, hospital) Medicare payment via the simplified IPPS
 * operating formula:
 *
 *   payment = SA × weight × (labor_share × WI + non_labor_share)
 *           × (1 + IME) × (1 + DSH_OPP)
 *
 * Capital payments (~5-7% of operating) and outlier/UCP add-ons are NOT
 * modeled in this v1 — call this out in the UI tooltip.
 *
 * Also seeds DRG titles into friendly_names so autocomplete can find them
 * by description ("vaginal delivery" → DRG 805, etc.).
 */

import { existsSync, mkdirSync, readFileSync, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'data');
const DRG_DIR = path.join(DATA_DIR, 'drg');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'prices.db');

const TABLE5_URL = 'https://www.cms.gov/files/zip/fy2026-ipps-fr-table-5.zip';
const TABLE5_ZIP = path.join(DRG_DIR, 'fy2026-ipps-fr-table-5.zip');
const TABLE5_TXT = path.join(DRG_DIR, 'CMS-1833-F Table 5.txt');

const IMPACT_URL = 'https://www.cms.gov/files/zip/fy2026-ipps-fr-impact-file.zip';
const IMPACT_ZIP = path.join(DRG_DIR, 'fy2026-ipps-fr-impact-file.zip');
const IMPACT_TXT = path.join(DRG_DIR, 'FY 2026 IPPS Final Rule Impact File.txt');

// FY 2026 IPPS final rule operating standardized amount (for hospitals
// participating in quality programs + meaningful EHR users).
const STANDARDIZED_AMOUNT = 6752.61;
// FY 2026 labor-related share (CMS rebased market basket; was 67.6% in FY 2025).
const LABOR_SHARE = 0.660;
const NON_LABOR_SHARE = 0.340;

// Map our hospital_id slugs to CMS Provider Numbers (CCNs).
const HOSPITAL_CCN = {
  'ascension-seton-austin': '450056',
  'dell-seton-austin': '450124',
  'bsw-austin': '670136',
  'st-davids-austin': '450431',
};

// Impact File column indices (0-based) per the variable description doc.
const IMPACT_COL = {
  provider_number: 0,
  name: 1,
  wage_index: 11,    // FY 2026 Wage Index (after reclass + floors + caps)
  ime_factor: 22,    // TCHOP — IME adjustment for operating IPPS
  dsh_factor: 25,    // DSHOPP — Operating DSH adjustment (post-75% reduction)
};

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`  Saved to ${dest}`);
}

function unzipFile(zipPath, pattern, outDir) {
  execSync(`unzip -j -o "${zipPath}" "${pattern}" -d "${outDir}"`, { stdio: 'pipe' });
}

function parseTable5(txtPath) {
  const raw = readFileSync(txtPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  // Header row is the one starting with "MS-DRG"
  const headerIdx = lines.findIndex(l => /^MS-DRG\s*\t/.test(l));
  if (headerIdx === -1) throw new Error('Could not find Table 5 header row');

  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const drg = (cols[0] || '').trim();
    if (!drg || !/^\d{3}$/.test(drg)) continue;

    const type = (cols[4] || '').trim();
    const title = (cols[5] || '').trim();
    const weight = parseFloat(cols[7]) || parseFloat(cols[6]) || 0;
    const gmlos = parseFloat(cols[8]) || null;
    const amlos = parseFloat(cols[9]) || null;
    if (!title || weight <= 0) continue;

    out.push({ drg_code: drg, drg_title: title, type, weight, gmlos, amlos });
  }
  return out;
}

function parseImpactFile(txtPath) {
  // Impact File is tab-delimited Windows-1252; read as latin1 to avoid the
  // multibyte conversion errors that show up around hyphens in hospital names.
  const raw = readFileSync(txtPath, 'latin1');
  const lines = raw.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => l.startsWith('Provider Number\t'));
  if (headerIdx === -1) throw new Error('Could not find Impact File header row');

  const ccnSet = new Set(Object.values(HOSPITAL_CCN));
  const ccnToId = {};
  for (const [hid, ccn] of Object.entries(HOSPITAL_CCN)) ccnToId[ccn] = hid;

  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const ccn = (cols[IMPACT_COL.provider_number] || '').trim().replace(/^"|"$/g, '');
    if (!ccnSet.has(ccn)) continue;

    out.push({
      ccn,
      hospital_id: ccnToId[ccn],
      name: (cols[IMPACT_COL.name] || '').trim().replace(/^"|"$/g, ''),
      wage_index: parseFloat(cols[IMPACT_COL.wage_index]) || 0,
      ime_factor: parseFloat(cols[IMPACT_COL.ime_factor]) || 0,
      dsh_factor: parseFloat(cols[IMPACT_COL.dsh_factor]) || 0,
    });
  }
  return out;
}

function computePayment(weight, hospital) {
  const wageAdjBase = STANDARDIZED_AMOUNT * (LABOR_SHARE * hospital.wage_index + NON_LABOR_SHARE);
  return wageAdjBase * weight * (1 + hospital.ime_factor) * (1 + hospital.dsh_factor);
}

function seedDatabase(drgs, hospitals) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS medicare_drgs (
      drg_code TEXT PRIMARY KEY,
      drg_title TEXT NOT NULL,
      type TEXT,
      weight REAL NOT NULL,
      geometric_mean_los REAL,
      arithmetic_mean_los REAL,
      year INTEGER DEFAULT 2026
    );
    CREATE TABLE IF NOT EXISTS medicare_drg_payments (
      drg_code TEXT NOT NULL,
      hospital_id TEXT NOT NULL,
      payment REAL NOT NULL,
      year INTEGER DEFAULT 2026,
      PRIMARY KEY (drg_code, hospital_id)
    );
    CREATE TABLE IF NOT EXISTS medicare_drg_hospital_factors (
      hospital_id TEXT PRIMARY KEY,
      ccn TEXT,
      name TEXT,
      wage_index REAL,
      ime_factor REAL,
      dsh_factor REAL,
      year INTEGER DEFAULT 2026
    );
  `);

  // Insert DRG weights
  const insertDrg = db.prepare(`
    INSERT OR REPLACE INTO medicare_drgs
      (drg_code, drg_title, type, weight, geometric_mean_los, arithmetic_mean_los)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const drgTx = db.transaction((rows) => {
    for (const r of rows) {
      insertDrg.run(r.drg_code, r.drg_title, r.type, r.weight, r.gmlos, r.amlos);
    }
  });
  drgTx(drgs);
  console.log(`  Seeded ${drgs.length} MS-DRG weights`);

  // Insert hospital factors
  const insertFactors = db.prepare(`
    INSERT OR REPLACE INTO medicare_drg_hospital_factors
      (hospital_id, ccn, name, wage_index, ime_factor, dsh_factor)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const h of hospitals) {
    insertFactors.run(h.hospital_id, h.ccn, h.name, h.wage_index, h.ime_factor, h.dsh_factor);
  }
  console.log(`  Seeded ${hospitals.length} hospital factor rows`);

  // Cross-product: payment per (DRG, hospital)
  const insertPay = db.prepare(`
    INSERT OR REPLACE INTO medicare_drg_payments (drg_code, hospital_id, payment)
    VALUES (?, ?, ?)
  `);
  const payTx = db.transaction(() => {
    for (const drg of drgs) {
      for (const h of hospitals) {
        const pay = computePayment(drg.weight, h);
        insertPay.run(drg.drg_code, h.hospital_id, Math.round(pay * 100) / 100);
      }
    }
  });
  payTx();
  console.log(`  Seeded ${drgs.length * hospitals.length} (DRG × hospital) payment rows`);

  // Also add DRG titles to friendly_names for autocomplete discovery.
  // Use lowercase, dedup-friendly format. Only insert if not already present.
  const checkFriendly = db.prepare(`SELECT 1 FROM friendly_names WHERE code = ?`);
  const insertFriendly = db.prepare(`
    INSERT INTO friendly_names (code, code_type, original_description, friendly_name, search_terms)
    VALUES (?, 'MS-DRG', ?, ?, ?)
  `);
  let added = 0;
  const friendlyTx = db.transaction(() => {
    for (const drg of drgs) {
      if (checkFriendly.get(drg.drg_code)) continue;
      const friendly = toFriendly(drg.drg_title);
      const searchTerms = `${drg.drg_code} ${drg.drg_title}`.toLowerCase();
      insertFriendly.run(drg.drg_code, drg.drg_title, friendly, searchTerms);
      added++;
    }
  });
  friendlyTx();
  console.log(`  Added ${added} DRG entries to friendly_names`);

  // Rebuild friendly_names_fts so autocomplete picks up the new rows
  try {
    db.exec("INSERT INTO friendly_names_fts(friendly_names_fts) VALUES('rebuild')");
    console.log('  Rebuilt friendly_names_fts index');
  } catch (e) {
    console.log(`  WARN: friendly_names_fts rebuild failed: ${e.message}`);
  }

  // Sanity check
  console.log('\nSample DRG payments:');
  const samples = ['470', '469', '871', '805', '291'];
  for (const drg of samples) {
    const drgRow = db.prepare(`SELECT drg_title, weight FROM medicare_drgs WHERE drg_code=?`).get(drg);
    if (!drgRow) { console.log(`  ${drg}: NOT FOUND`); continue; }
    console.log(`  DRG ${drg} (weight=${drgRow.weight}) — ${drgRow.drg_title}`);
    const payments = db.prepare(`
      SELECT p.hospital_id, p.payment, f.ime_factor, f.dsh_factor
      FROM medicare_drg_payments p
      JOIN medicare_drg_hospital_factors f ON f.hospital_id = p.hospital_id
      WHERE p.drg_code = ?
      ORDER BY p.payment DESC
    `).all(drg);
    for (const p of payments) {
      console.log(`    ${p.hospital_id.padEnd(24)} $${p.payment.toFixed(2).padStart(10)}  IME=${(p.ime_factor*100).toFixed(1)}% DSH=${(p.dsh_factor*100).toFixed(1)}%`);
    }
  }

  db.close();
}

// Lightweight "Title Case" — DRG titles are SHOUTED ALL CAPS by CMS.
function toFriendly(s) {
  return s
    .split(/\s+/)
    .map(w => {
      if (['MCC', 'CC', 'OR', 'D&C', 'AMI', 'CHF', 'COPD', 'GI', 'IV', 'I/V', 'ICU', 'ECG', 'EKG'].includes(w)) return w;
      if (w === 'WITH' || w === 'WITHOUT' || w === 'AND' || w === 'OR' || w === 'OF') return w.toLowerCase();
      // Sentence-case longer words
      if (w.length <= 1) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/^./, c => c.toUpperCase());
}

async function main() {
  if (!existsSync(DRG_DIR)) mkdirSync(DRG_DIR, { recursive: true });

  if (!existsSync(TABLE5_ZIP)) await downloadFile(TABLE5_URL, TABLE5_ZIP);
  else console.log(`Using cached ${TABLE5_ZIP}`);
  if (!existsSync(TABLE5_TXT)) unzipFile(TABLE5_ZIP, '*Table 5.txt', DRG_DIR);

  if (!existsSync(IMPACT_ZIP)) await downloadFile(IMPACT_URL, IMPACT_ZIP);
  else console.log(`Using cached ${IMPACT_ZIP}`);
  if (!existsSync(IMPACT_TXT)) unzipFile(IMPACT_ZIP, '*Impact File.txt', DRG_DIR);

  console.log('\nParsing Table 5 (MS-DRG weights)...');
  const drgs = parseTable5(TABLE5_TXT);
  console.log(`  ${drgs.length} DRGs parsed`);

  console.log('\nParsing Impact File for Austin hospitals...');
  const hospitals = parseImpactFile(IMPACT_TXT);
  for (const h of hospitals) {
    console.log(`  ${h.hospital_id.padEnd(24)} ccn=${h.ccn} WI=${h.wage_index} IME=${(h.ime_factor*100).toFixed(2)}% DSH=${(h.dsh_factor*100).toFixed(2)}%`);
  }
  if (hospitals.length !== Object.keys(HOSPITAL_CCN).length) {
    console.warn(`  WARN: expected ${Object.keys(HOSPITAL_CCN).length} hospitals but matched ${hospitals.length}`);
  }

  console.log(`\nSA=$${STANDARDIZED_AMOUNT} labor_share=${LABOR_SHARE} non_labor_share=${NON_LABOR_SHARE}`);
  console.log('Seeding database...');
  seedDatabase(drgs, hospitals);

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
