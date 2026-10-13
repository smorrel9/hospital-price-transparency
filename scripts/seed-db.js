/**
 * seed-db.js
 * Loads parsed NDJSON data into SQLite with FTS indexes.
 *
 * Reads NDJSON (one JSON object per line) to avoid loading the full dataset
 * into memory. Uses batch inserts for performance.
 *
 * Usage: node scripts/seed-db.js <hospital_id>   (one hospital, non-destructive)
 *        npm run seed-db:rebuild                 (destructive full rebuild)
 */

import { createReadStream, readdirSync, unlinkSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import path from 'path';
import { buildSummaryStats } from './build-summary-stats.js';
import { DB_PATH, PARSED_DIR, IS_PRODUCTION } from './paths.js';

const BATCH_SIZE = 5000;

// Only keep consumer-useful code types (drop RC, CDM, NULL)
const KEEP_CODE_TYPES = new Set(['CPT', 'HCPCS', 'MS-DRG', 'APR-DRG', 'TRIS-DRG']);

function createSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS procedures_fts;
    DROP TABLE IF EXISTS procedures;

    CREATE TABLE procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id TEXT NOT NULL,
      description TEXT,
      code TEXT,
      code_type TEXT,
      rev_code TEXT,
      modifiers TEXT,
      setting TEXT,
      gross_charge REAL,
      cash_price REAL,
      payer_name TEXT,
      plan_name TEXT,
      negotiated_rate REAL,
      negotiated_percentage REAL,
      negotiated_algorithm TEXT,
      methodology TEXT,
      min_negotiated REAL,
      max_negotiated REAL,
      notes TEXT,
      UNIQUE(code, code_type, hospital_id, payer_name, plan_name, setting, negotiated_rate, methodology)
    );

    -- Full-text search index on description and codes
    CREATE VIRTUAL TABLE procedures_fts USING fts5(
      description, code, rev_code, payer_name,
      content='procedures',
      content_rowid='id'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER procedures_ai AFTER INSERT ON procedures BEGIN
      INSERT INTO procedures_fts(rowid, description, code, rev_code, payer_name)
      VALUES (new.id, new.description, new.code, new.rev_code, new.payer_name);
    END;

    CREATE TRIGGER procedures_ad AFTER DELETE ON procedures BEGIN
      INSERT INTO procedures_fts(procedures_fts, rowid, description, code, rev_code, payer_name)
      VALUES ('delete', old.id, old.description, old.code, old.rev_code, old.payer_name);
    END;
  `);
}

/**
 * The AFTER DELETE trigger above didn't exist before per-hospital upsert was
 * added -- any DB built by an older version of this script (including the
 * current production DB) is missing it. Without it, deleting a hospital's
 * rows to re-seed them would leave orphaned entries in procedures_fts
 * pointing at ids that no longer exist in procedures. Idempotent, so it's
 * safe to call every time.
 */
function ensureDeleteTrigger(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS procedures_ad AFTER DELETE ON procedures BEGIN
      INSERT INTO procedures_fts(procedures_fts, rowid, description, code, rev_code, payer_name)
      VALUES ('delete', old.id, old.description, old.code, old.rev_code, old.payer_name);
    END;
  `);
}

async function seedFile(db, filepath, hospitalId) {
  console.log(`[seed] ${path.basename(filepath)} -> ${hospitalId}`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO procedures (
      hospital_id, description, code, code_type, rev_code, modifiers, setting,
      gross_charge, cash_price, payer_name, plan_name,
      negotiated_rate, negotiated_percentage, negotiated_algorithm,
      methodology, min_negotiated, max_negotiated, notes
    ) VALUES (
      @hospital_id, @description, @code, @code_type, @rev_code, @modifiers, @setting,
      @gross_charge, @cash_price, @payer_name, @plan_name,
      @negotiated_rate, @negotiated_percentage, @negotiated_algorithm,
      @methodology, @min_negotiated, @max_negotiated, @notes
    )
  `);

  // Returns the number of rows actually inserted (vs. ignored as duplicates),
  // via better-sqlite3's own per-statement .changes -- not a SELECT COUNT(*),
  // which would rescan the whole (and ever-growing) table on every batch.
  const insertBatch = db.transaction((rows) => {
    let inserted = 0;
    for (const row of rows) {
      inserted += insert.run(row).changes;
    }
    return inserted;
  });

  const rl = createInterface({
    input: createReadStream(filepath),
    crlfDelay: Infinity,
  });

  let batch = [];
  let total = 0;
  let skipped = 0;
  let deduped = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    const record = JSON.parse(line);

    // Filter: only keep consumer-useful code types
    if (!record.code_type || !KEEP_CODE_TYPES.has(record.code_type)) {
      skipped++;
      continue;
    }

    record.hospital_id = hospitalId;
    batch.push(record);

    if (batch.length >= BATCH_SIZE) {
      const inserted = insertBatch(batch);
      deduped += batch.length - inserted;
      total += batch.length;
      batch = [];

      if (total % 500000 === 0) {
        console.log(`  ... ${(total / 1000000).toFixed(1)}M rows processed (${skipped.toLocaleString()} filtered, ${deduped.toLocaleString()} deduped)`);
      }
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const inserted = insertBatch(batch);
    deduped += batch.length - inserted;
    total += batch.length;
  }

  console.log(`  Processed ${total.toLocaleString()} rows, skipped ${skipped.toLocaleString()} (non-CPT/HCPCS/DRG), deduped ${deduped.toLocaleString()}`);
}

/**
 * Replace one hospital's rows without touching anyone else's or rebuilding
 * the whole database. The old full-rebuild path re-parsed and re-inserted
 * every hospital's file on every run -- fine at a handful of hospitals,
 * a genuine traffic jam once several Sprites are each onboarding a
 * different hospital on their own schedule (see docs/decision-log.md).
 */
async function upsertHospital(db, hospitalId, filepath) {
  ensureDeleteTrigger(db);

  const before = db.prepare(
    'SELECT COUNT(*) as n FROM procedures WHERE hospital_id = ?'
  ).get(hospitalId).n;

  db.prepare('DELETE FROM procedures WHERE hospital_id = ?').run(hospitalId);
  console.log(`[upsert] Removed ${before.toLocaleString()} existing rows for ${hospitalId}`);

  await seedFile(db, filepath, hospitalId);
  createIndexes(db);
  buildSummaryStats(db);

  const after = db.prepare(
    'SELECT COUNT(*) as n FROM procedures WHERE hospital_id = ?'
  ).get(hospitalId).n;
  const total = db.prepare('SELECT COUNT(*) as n FROM procedures').get().n;

  console.log(`\n${hospitalId}: ${after.toLocaleString()} rows (was ${before.toLocaleString()})`);
  console.log(`Database total: ${total.toLocaleString()} rows`);
}

function createIndexes(db) {
  console.log('[seed] Creating indexes...');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_procedures_code ON procedures(code);
    CREATE INDEX IF NOT EXISTS idx_procedures_hospital ON procedures(hospital_id);
    CREATE INDEX IF NOT EXISTS idx_procedures_payer ON procedures(payer_name);
    CREATE INDEX IF NOT EXISTS idx_procedures_setting ON procedures(setting);
    CREATE INDEX IF NOT EXISTS idx_procedures_description ON procedures(description);
    CREATE INDEX IF NOT EXISTS idx_procedures_payer_hospital ON procedures(payer_name, hospital_id);
  `);
  console.log('  Indexes created.');
}

function usage(reason) {
  if (reason) console.error(`\n${reason}\n`);
  console.error(`Usage:
  node scripts/seed-db.js <hospital_id>   Replace one hospital's rows (needs an existing DB)
  node scripts/seed-db.js --rebuild-all   DESTRUCTIVE: delete the DB and rebuild from every
                                          file in data/parsed/

Database: ${DB_PATH}

A bare invocation does nothing on purpose. The no-args full rebuild used to be
the default, which deleted the live production database on 2026-10-13 -- the
destructive path now has to be asked for by name. See docs/known-issues.md.`);
}

async function main() {
  const args = process.argv.slice(2);
  const rebuildAll = args.includes('--rebuild-all');
  const allowProduction = args.includes('--allow-production');
  const targetHospital = args.find(a => !a.startsWith('--'));

  if (!targetHospital && !rebuildAll) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (targetHospital && rebuildAll) {
    usage('Pass either a hospital id or --rebuild-all, not both.');
    process.exitCode = 1;
    return;
  }

  console.log(`[seed] database: ${DB_PATH}`);

  // Single-hospital upsert mode: `node scripts/seed-db.js <hospital_id>`.
  // Requires an existing DB -- this replaces one hospital's rows in place,
  // it doesn't build a database from scratch.
  if (targetHospital) {
    const filepath = path.join(PARSED_DIR, `${targetHospital}.ndjson`);
    if (!existsSync(filepath)) {
      console.error(`No parsed file found for "${targetHospital}" at ${filepath}`);
      process.exitCode = 1;
      return;
    }
    if (!existsSync(DB_PATH)) {
      console.error(`No existing database at ${DB_PATH} -- build one first with "npm run seed-db:rebuild".`);
      process.exitCode = 1;
      return;
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');

    await upsertHospital(db, targetHospital, filepath);

    db.close();
    return;
  }

  // Full rebuild from scratch. Destructive and explicitly opt-in.
  if (IS_PRODUCTION && !allowProduction) {
    console.error(`Refusing to rebuild: NODE_ENV=production and this would delete ${DB_PATH}.

To add or refresh a single hospital, pass its id instead -- that path is
non-destructive to every other hospital. If you genuinely mean to rebuild the
deployed database in place, re-run with --allow-production, and read
docs/decision-log.md ("Production data deploys") first: the intended way to
publish data is to build an artifact elsewhere and swap it in, not to rebuild
the database a live server is reading.`);
    process.exitCode = 1;
    return;
  }

  if (existsSync(DB_PATH)) {
    // Say out loud what is about to be destroyed. A silent "Removed old
    // database." is what this looked like while it deleted 8.1M live rows.
    let existing = 'unreadable';
    try {
      const old = new Database(DB_PATH, { readonly: true });
      existing = `${old.prepare('SELECT COUNT(*) as n FROM procedures').get().n.toLocaleString()} rows`;
      old.close();
    } catch {
      // Corrupt or truncated file -- rebuilding over it is the right move anyway.
    }
    console.log(`[seed] deleting existing database (${existing})`);
    unlinkSync(DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');    // safe bulk insert
  db.pragma('cache_size = -64000');    // 64MB cache

  createSchema(db);

  const files = readdirSync(PARSED_DIR).filter(f => f.endsWith('.ndjson'));
  if (files.length === 0) {
    console.log('No NDJSON files found in data/parsed/. Run "npm run parse-data" first.');
    db.close();
    return;
  }

  for (const file of files) {
    const hospitalId = file.replace('.ndjson', '');
    const filepath = path.join(PARSED_DIR, file);
    await seedFile(db, filepath, hospitalId);
  }

  createIndexes(db);
  buildSummaryStats(db);

  // Quick stats
  const count = db.prepare('SELECT COUNT(*) as n FROM procedures').get();
  const payers = db.prepare('SELECT COUNT(DISTINCT payer_name) as n FROM procedures WHERE payer_name IS NOT NULL').get();
  const codes = db.prepare('SELECT COUNT(DISTINCT code) as n FROM procedures WHERE code IS NOT NULL').get();

  console.log(`\nDatabase ready: ${DB_PATH}`);
  console.log(`  ${count.n} rows, ${payers.n} payers, ${codes.n} unique codes`);

  db.close();
}

main().catch(console.error);
