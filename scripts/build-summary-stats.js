/**
 * build-summary-stats.js
 * Precomputes the aggregate stats that /api/hospitals, /api/stats, and
 * /api/payer-categories used to compute live on every request.
 *
 * better-sqlite3 is synchronous, so a full-table GROUP BY/DISTINCT scan
 * blocks the whole single-threaded Node event loop for every visitor while
 * it runs -- at 7M+ rows that's 12-60+ seconds depending on disk cache
 * state, and it happens on every cold start since nothing was cached across
 * restarts. Computing these once here (at seed time, when the data is
 * already hot) and storing them in tiny tables means the server never runs
 * these queries against live traffic again.
 *
 * Run after seed-db.js. Also invoked from seed-db.js's own main() so every
 * future reseed stays self-maintaining.
 */

import Database from 'better-sqlite3';
import { DB_PATH } from './paths.js';

const CATEGORY_PATTERNS = [
  { category: 'BCBS',     test: n => /BCBS|Blue\s*Cross|BLUE/i.test(n) },
  { category: 'Aetna',    test: n => /AETNA|Aetna/i.test(n) },
  { category: 'United',   test: n => /UNITED|UHC|Uhc/i.test(n) },
  { category: 'Cigna',    test: n => /CIGNA|Cigna/i.test(n) },
  { category: 'Humana',   test: n => /HUMANA|Humana/i.test(n) },
  { category: 'Medicare', test: n => /MEDICARE|Medicare/i.test(n) },
  { category: 'Medicaid', test: n => /MEDICAID|Medicaid|STAR|CHIP/i.test(n) },
];

function buildPayerCategoriesJson(db) {
  const rows = db.prepare(`
    SELECT DISTINCT payer_name, hospital_id
    FROM procedures
    WHERE payer_name IS NOT NULL
  `).all();

  const groups = {};
  for (const { payer_name, hospital_id } of rows) {
    let matched = false;
    for (const { category, test } of CATEGORY_PATTERNS) {
      if (test(payer_name)) {
        if (!groups[category]) groups[category] = {};
        if (!groups[category][payer_name]) groups[category][payer_name] = new Set();
        groups[category][payer_name].add(hospital_id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!groups['Other']) groups['Other'] = {};
      if (!groups['Other'][payer_name]) groups['Other'][payer_name] = new Set();
      groups['Other'][payer_name].add(hospital_id);
    }
  }

  return Object.entries(groups).map(([category, payers]) => ({
    category,
    payers: Object.entries(payers).map(([payer_name, hospitalSet]) => ({
      payer_name,
      hospital_ids: Array.from(hospitalSet),
    })),
  }));
}

export function buildSummaryStats(db) {
  console.log('[summary-stats] Building hospital_stats...');
  db.exec(`
    DROP TABLE IF EXISTS hospital_stats;
    CREATE TABLE hospital_stats (
      hospital_id TEXT PRIMARY KEY,
      record_count INTEGER,
      unique_codes INTEGER,
      payer_count INTEGER
    );
  `);
  const hospitalRows = db.prepare(`
    SELECT hospital_id,
      COUNT(*) as record_count,
      COUNT(DISTINCT code) as unique_codes,
      COUNT(DISTINCT payer_name) as payer_count
    FROM procedures
    GROUP BY hospital_id
  `).all();
  const insertHospital = db.prepare(
    'INSERT INTO hospital_stats (hospital_id, record_count, unique_codes, payer_count) VALUES (?, ?, ?, ?)'
  );
  for (const r of hospitalRows) {
    insertHospital.run(r.hospital_id, r.record_count, r.unique_codes, r.payer_count);
  }
  console.log(`  ${hospitalRows.length} hospitals`);

  console.log('[summary-stats] Building db_stats...');
  const total = db.prepare('SELECT COUNT(*) as count FROM procedures').get();
  const payers = db.prepare('SELECT COUNT(DISTINCT payer_name) as count FROM procedures WHERE payer_name IS NOT NULL').get();
  const codes = db.prepare('SELECT COUNT(DISTINCT code) as count FROM procedures WHERE code IS NOT NULL').get();
  const settings = db.prepare('SELECT setting, COUNT(*) as count FROM procedures GROUP BY setting').all();
  const settingCounts = {};
  for (const s of settings) settingCounts[s.setting || 'UNKNOWN'] = s.count;

  db.exec(`
    DROP TABLE IF EXISTS db_stats;
    CREATE TABLE db_stats (id INTEGER PRIMARY KEY CHECK (id = 1), stats_json TEXT);
  `);
  db.prepare('INSERT INTO db_stats (id, stats_json) VALUES (1, ?)').run(JSON.stringify({
    total_records: total.count,
    payers: payers.count,
    unique_codes: codes.count,
    settings: settingCounts,
  }));
  console.log('  done');

  console.log('[summary-stats] Building payer_category_stats (this is the slow one)...');
  const categories = buildPayerCategoriesJson(db);
  db.exec(`
    DROP TABLE IF EXISTS payer_category_stats;
    CREATE TABLE payer_category_stats (id INTEGER PRIMARY KEY CHECK (id = 1), categories_json TEXT);
  `);
  db.prepare('INSERT INTO payer_category_stats (id, categories_json) VALUES (1, ?)').run(JSON.stringify(categories));
  console.log(`  ${categories.length} categories`);
}

async function main() {
  const db = new Database(DB_PATH);
  buildSummaryStats(db);
  db.close();
  console.log('\nSummary stats cached.');
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
