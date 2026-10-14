/**
 * import-medicare.js
 * Copy the Medicare reference tables from another database into this one.
 *
 * These four tables are not produced by the normal pipeline -- they come from
 * fetch-medicare / fetch-opps / fetch-drg, which were last run in June 2026 and
 * which `seed-db.js --rebuild-all` drops on every full rebuild. The populated
 * copy was found 2026-04-25-vintage in an orphaned database while moving the
 * repo off a Google Drive mount, one decision away from being deleted as junk.
 * This script exists so restoring them is repeatable rather than archaeology.
 *
 * Usage:
 *   node scripts/import-medicare.js <source.db>
 *   node scripts/import-medicare.js <source.db> --replace   (overwrite existing)
 *
 * IMPORTANT -- these are not locality-neutral:
 *   medicare_rates carries `locality` and `opps_austin_payment`, i.e. the CMS
 *   Physician Fee Schedule and OPPS figures are for the Austin wage area. They
 *   are correct for the four original Austin hospitals and WRONG for Houston
 *   and Dallas. The API returns `locality` and the UI renders it, so nothing is
 *   presented as universal -- but see docs/known-issues.md for the open work on
 *   per-locality rates before this is trustworthy outside Austin.
 *   The DRG tables are already per-hospital and simply have no rows for
 *   non-Austin hospitals, which degrades correctly.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import path from 'path';
import { DB_PATH } from './paths.js';

const TABLES = [
  'medicare_rates',
  'medicare_drgs',
  'medicare_drg_payments',
  'medicare_drg_hospital_factors',
];

const args = process.argv.slice(2);
const REPLACE = args.includes('--replace');
const source = args.find(a => !a.startsWith('--'));

function main() {
  if (!source) {
    console.error('Usage: node scripts/import-medicare.js <source.db> [--replace]');
    process.exitCode = 1;
    return;
  }
  const src = path.resolve(source);
  if (!existsSync(src)) {
    console.error(`No database at ${src}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DB_PATH)) {
    console.error(`No target database at ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }
  if (src === DB_PATH) {
    console.error('Source and target are the same database.');
    process.exitCode = 1;
    return;
  }

  console.log(`source: ${src}`);
  console.log(`target: ${DB_PATH}\n`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Single-quote escaping: the path is ours, but ATTACH takes a SQL string.
  db.exec(`ATTACH '${src.replace(/'/g, "''")}' AS src`);

  try {
    const srcTables = new Set(
      db.prepare("SELECT name FROM src.sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    const missing = TABLES.filter(t => !srcTables.has(t));
    if (missing.length) {
      console.error(`Source is missing: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const imported = [];
    for (const t of TABLES) {
      const existsHere = db
        .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?")
        .get(t);

      if (existsHere) {
        const have = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
        if (have > 0 && !REPLACE) {
          console.log(`  skip  ${t.padEnd(32)} already has ${have.toLocaleString()} rows (pass --replace to overwrite)`);
          continue;
        }
        db.exec(`DROP TABLE main.${t}`);
      }

      // Recreate with the source's own DDL so column types and constraints
      // survive -- CREATE TABLE AS SELECT would silently drop them.
      const ddl = db
        .prepare("SELECT sql FROM src.sqlite_master WHERE type='table' AND name = ?")
        .get(t).sql;
      db.exec(ddl);
      db.exec(`INSERT INTO main.${t} SELECT * FROM src.${t}`);

      // And any indexes the source had on it.
      const idx = db
        .prepare("SELECT sql FROM src.sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL")
        .all(t);
      for (const i of idx) db.exec(i.sql);

      const n = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
      console.log(`  ok    ${t.padEnd(32)} ${n.toLocaleString()} rows${idx.length ? `, ${idx.length} index(es)` : ''}`);
      imported.push(t);
    }

    if (!imported.length) {
      console.log('\nNothing imported.');
      return;
    }

    // --- Report what the data actually covers, so the Austin scope is visible ---
    const localities = db
      .prepare('SELECT DISTINCT locality FROM main.medicare_rates WHERE locality IS NOT NULL')
      .all()
      .map(r => r.locality);
    const drgHospitals = db
      .prepare('SELECT DISTINCT hospital_id FROM main.medicare_drg_payments ORDER BY hospital_id')
      .all()
      .map(r => r.hospital_id);
    const allHospitals = db
      .prepare('SELECT hospital_id FROM main.hospital_stats ORDER BY hospital_id')
      .all()
      .map(r => r.hospital_id);
    const without = allHospitals.filter(h => !drgHospitals.includes(h));

    console.log(`\nfee-schedule locality: ${localities.join(', ') || '(none recorded)'}`);
    console.log(`DRG payments cover:    ${drgHospitals.join(', ')}`);
    if (without.length) {
      console.log(`no DRG payments for:   ${without.join(', ')}`);
      console.log(`  (expected -- IME/DSH factors only exist for the original Austin hospitals.`);
      console.log(`   Those hospitals show no DRG benchmark, which is correct rather than wrong.)`);
    }
    console.log(
      `\nWARNING: the fee-schedule rates above are for the ${localities.join('/') || 'recorded'} locality.\n` +
      `They are correct for Austin hospitals only. The API returns \`locality\` and the UI\n` +
      `renders it, so nothing claims to be universal -- but per-locality rates for Houston\n` +
      `and Dallas are open work. See docs/known-issues.md.`
    );
  } finally {
    db.exec('DETACH src');
    db.close();
  }
}

main();
