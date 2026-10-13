/**
 * verify-db.js
 * Checks what the database actually contains against what the manifest claims.
 *
 * Exists because `status: "seeded"` in data/hospitals.json is a hand-written
 * assertion that nothing verified. On 2026-10-13 memorial-hermann-tmc was
 * marked seeded while having zero rows in both the canonical DB and
 * production -- it had only ever been seeded onto a Sprite that was later
 * destroyed. Caught by a one-off sanity query, which is not a system.
 *
 * Run before publishing data anywhere. Exits non-zero if anything disagrees,
 * so it can gate a deploy rather than just inform a human.
 *
 * Usage: node scripts/verify-db.js
 *        DB_PATH=/data/prices.db node scripts/verify-db.js   (e.g. on production)
 *
 * Works without the manifest (production has no repo checkout of data/), in
 * which case the manifest comparison is skipped and the DB-only checks run.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { DB_PATH, MANIFEST_PATH } from './paths.js';

// Tables the site actively depends on. friendly_names is here because its
// absence is a hard 500 on /api/autocomplete, which shipped unnoticed once.
const REQUIRED_TABLES = [
  'procedures',
  'procedures_fts',
  'friendly_names',
  'hospital_stats',
  'db_stats',
  'payer_category_stats',
];

// Known-absent and logged in docs/known-issues.md. Reported, never fatal.
const OPTIONAL_TABLES = ['medicare_rates', 'medicare_drgs', 'medicare_drg_payments'];

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?"
  ).get(name);
}

function main() {
  const problems = [];
  const notes = [];

  if (!existsSync(DB_PATH)) {
    console.error(`FAIL: no database at ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });
  console.log(`database: ${DB_PATH}\n`);

  // --- Required tables present and populated ---
  for (const t of REQUIRED_TABLES) {
    if (!tableExists(db, t)) {
      problems.push(`required table "${t}" is missing`);
      continue;
    }
    const n = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n;
    if (n === 0) problems.push(`required table "${t}" exists but is empty`);
  }
  for (const t of OPTIONAL_TABLES) {
    if (!tableExists(db, t)) notes.push(`optional table "${t}" absent (see docs/known-issues.md)`);
  }

  // --- Per-hospital counts, straight from procedures ---
  // Deliberately one indexed COUNT per hospital rather than a GROUP BY over
  // the whole table: the full-table aggregate is the pattern that froze the
  // site in the 2026-10-12 outage.
  const dbHospitals = db
    .prepare('SELECT DISTINCT hospital_id FROM procedures ORDER BY hospital_id')
    .all()
    .map(r => r.hospital_id);

  const actual = new Map();
  for (const id of dbHospitals) {
    actual.set(id, db.prepare('SELECT COUNT(*) as n FROM procedures WHERE hospital_id = ?').get(id).n);
  }

  // --- Compare against hospital_stats, which is what the API actually serves ---
  const stats = new Map();
  if (tableExists(db, 'hospital_stats')) {
    for (const r of db.prepare('SELECT hospital_id, record_count FROM hospital_stats').all()) {
      stats.set(r.hospital_id, r.record_count);
    }
  }

  // --- Compare against the manifest, when we have one ---
  let claimed = null;
  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    claimed = new Map(
      manifest.hospitals.filter(h => h.status === 'seeded').map(h => [h.id, h])
    );
  } else {
    notes.push(`manifest not found at ${MANIFEST_PATH} -- skipped manifest comparison`);
  }

  // --- Report ---
  const ids = [...new Set([...actual.keys(), ...(claimed?.keys() ?? []), ...stats.keys()])].sort();
  const pad = Math.max(...ids.map(i => i.length), 10);

  console.log(`${'hospital'.padEnd(pad)}  ${'rows'.padStart(11)}  ${'stats'.padStart(11)}  manifest`);
  for (const id of ids) {
    const rows = actual.get(id);
    const stat = stats.get(id);
    const inManifest = claimed ? (claimed.has(id) ? 'seeded' : '-') : '?';

    console.log(
      `${id.padEnd(pad)}  ${(rows ?? 0).toLocaleString().padStart(11)}  ` +
      `${(stat ?? 0).toLocaleString().padStart(11)}  ${inManifest}`
    );

    if (claimed?.has(id) && !rows) {
      problems.push(`${id}: manifest says seeded, but the database has no rows for it`);
    }
    if (rows && claimed && !claimed.has(id)) {
      problems.push(`${id}: has ${rows.toLocaleString()} rows but is not marked seeded in the manifest`);
    }
    if (rows && stat !== undefined && stat !== rows) {
      problems.push(
        `${id}: hospital_stats says ${stat.toLocaleString()} rows but procedures has ${rows.toLocaleString()} ` +
        `-- summary stats are stale, re-run a seed to refresh them`
      );
    }
    if (rows && stat === undefined) {
      problems.push(`${id}: has rows but no hospital_stats entry -- the API will not list it`);
    }
  }

  const total = [...actual.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${ids.length} hospitals, ${total.toLocaleString()} rows`);

  db.close();

  for (const n of notes) console.log(`note: ${n}`);

  if (problems.length) {
    console.error(`\nFAIL (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: database and manifest agree.');
}

main();
