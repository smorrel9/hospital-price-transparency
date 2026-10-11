/**
 * preflight-check.js
 * Quick, read-only sanity check on a hospital's RAW file, before running the
 * full parse/seed pipeline. Samples -- seconds, not minutes -- to catch the
 * structural surprises that have actually bitten this pipeline:
 *
 *   1. Layout: tall (generic payer_name/plan_name columns) vs wide (payer
 *      and plan baked into column names) -- MD Anderson was wide.
 *   2. Code-type mislabeling: a labeled code_type whose sampled codes don't
 *      match that type's expected shape (e.g. "HCPCS" codes that are
 *      actually 5-digit-numeric CPT) -- BSW and Houston Methodist both hit
 *      this.
 *
 * For CSV, mislabeling isn't necessarily spread evenly through a file --
 * BSW's is clustered mid-file (a prefix-only sample found a 2.9% mismatch
 * rate; the real rate confirmed against the full file is ~35-48%), and
 * Houston Methodist's JSON lists thousands of pharmacy/NDC items before any
 * HCPCS/CPT procedure code appears at all. So CSV sampling reads multiple
 * windows spread across the whole file (byte-offset seeks at 0/25/50/75/90%
 * of file size) rather than just the start, and JSON sampling keeps
 * scanning past category-heavy prefixes until it collects enough samples of
 * the types this script actually has expectations for.
 *
 * This does NOT replace the schema-mapper subagent or the data-qa subagent
 * -- it's the cheap first look that tells you whether either of those needs
 * to dig deeper, before you spend 10+ minutes on a full parse+seed run. A
 * clean pre-flight result is a good sign, not a guarantee -- it's sampling,
 * not a full scan.
 *
 * Usage: node scripts/preflight-check.js <hospital-id>
 */

import { createReadStream, existsSync, statSync } from 'fs';
import { parse } from 'csv-parse';
import path from 'path';
import { parser as jsonParser } from 'stream-json/parser.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { pick } from 'stream-json/filters/pick.js';
import chain from 'stream-chain';
import { COLUMN_MAP, detectLayout } from './parse-csv.js';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');

// Expected code shape per labeled type. Used to flag likely mislabeling,
// not to silently fix it -- a hospital-specific promotion rule still needs
// human review (see data/column-maps/<id>.json, docs/adding-a-hospital.md).
const EXPECTED_PATTERN = {
  CPT: /^\d{5}$/,
  HCPCS: /^[A-Z]\d{4}$/,
  // DRG codes are commonly represented as a 3-digit base DRG, sometimes with
  // a trailing severity-of-illness digit appended (e.g. APR-DRG "0061" =
  // base DRG 006 + SOI 1) -- allow up to 4 digits, not just 1-3.
  'MS-DRG': /^\d{1,4}$/,
  'APR-DRG': /^\d{1,4}$/,
  'TRIS-DRG': /^\d{1,4}$/,
  RC: /^\d{3,4}$/,
};

// Files can group rows/items by category (e.g. Houston Methodist lists
// thousands of pharmacy/NDC items before any HCPCS/CPT procedure code
// appears), so "sample the first N rows" can miss the types we actually
// have expectations for entirely. Worse, BSW's mislabeling itself is
// clustered mid-file, not spread evenly through its HCPCS-labeled rows --
// scanning only a prefix window found a 2.9% mismatch rate there, while the
// real rate (confirmed against the full file) is ~35% starting partway
// through. A single contiguous window, no matter how it's chosen to start,
// can't be trusted. For CSV (byte-seekable) we sample multiple windows
// spread across the whole file instead of just the start.
const TARGET_INTERESTING_SAMPLES = 3000;
const MAX_ITEMS_SCANNED = 150000;
const PER_WINDOW_ROW_CAP = 3000;
const WINDOW_FRACTIONS = [0, 0.25, 0.5, 0.75, 0.9];

function summarizeCodeSamples(samples) {
  const byType = {};
  for (const { code, codeType } of samples) {
    if (!codeType || !code) continue;
    byType[codeType] = byType[codeType] || { total: 0, matchesOwnPattern: 0, mismatchExamples: [] };
    const bucket = byType[codeType];
    bucket.total++;
    const pattern = EXPECTED_PATTERN[codeType];
    if (!pattern || pattern.test(code)) {
      bucket.matchesOwnPattern++;
    } else if (bucket.mismatchExamples.length < 5) {
      bucket.mismatchExamples.push(code);
    }
  }

  const findings = [];
  for (const [type, bucket] of Object.entries(byType)) {
    const mismatchPct = 100 * (1 - bucket.matchesOwnPattern / bucket.total);
    if (mismatchPct > 10) {
      // Some sources store codes as spreadsheet floats ("90707.0" instead
      // of "90707") -- strip that before checking what type the mismatch
      // actually looks like, purely for the hint; the mismatch itself was
      // already detected correctly against the raw value above.
      const stripped = bucket.mismatchExamples.map(c => c.replace(/\.0+$/, ''));
      const suspects = Object.entries(EXPECTED_PATTERN)
        .filter(([other]) => other !== type)
        .filter(([, p]) => stripped.some(c => p.test(c)))
        .map(([t]) => t);
      findings.push({
        type, total: bucket.total,
        mismatchPct: mismatchPct.toFixed(1) + '%',
        mismatchExamples: bucket.mismatchExamples,
        suspectedActualType: suspects,
      });
    }
  }
  return { byType, findings };
}

function extractSamples(row, headerMap) {
  const record = {};
  for (let i = 0; i < row.length; i++) {
    const field = headerMap[i];
    if (field) record[field] = row[i] || null;
  }
  const slots = [
    [record.code, record.code_type],
    [record.rev_code, record.rev_code_type],
    [record.hcpcs_code, record.hcpcs_code_type],
  ];
  const found = [];
  for (const [code, codeType] of slots) {
    if (code && codeType) found.push({ code, codeType: codeType.toUpperCase() });
  }
  return found;
}

/**
 * Scan one window of a CSV file starting at a given byte offset, collecting
 * code samples. headerMap is null only for the first window, which also has
 * to find the header row itself; later windows start mid-file (likely
 * mid-row) so the first parsed row is discarded as a probable fragment.
 */
async function scanCsvWindow(filepath, startByte, headerMap) {
  return new Promise((resolve, reject) => {
    const isFirstWindow = headerMap === null;
    let localHeaderMap = headerMap;
    let headers = null;
    let layout = null;
    let unmapped = [];
    const samples = [];
    let rowCount = 0;
    let interestingCount = 0;
    let discardedFirst = !isFirstWindow ? false : true; // first window has a real header to find, nothing to discard

    const csvParser = createReadStream(filepath, { start: startByte })
      .pipe(parse({ relax_column_count: true, skip_empty_lines: true, trim: true, bom: true }));

    csvParser.on('data', (row) => {
      if (isFirstWindow && !headers) {
        const lower = row.map(c => c.toLowerCase().trim());
        const hasDescription = lower.some(c => c === 'description');
        const hasCharge = lower.some(c => c.includes('charge') || c.includes('price'));
        if (hasDescription && hasCharge) {
          headers = row.map(c => c.trim());
          layout = detectLayout(headers);
          localHeaderMap = headers.map(h => COLUMN_MAP[h] || null);
          unmapped = headers.filter(h => !COLUMN_MAP[h] && h !== 'payer_name' && h !== 'plan_name'
            && !h.startsWith('standard_charge|') && !h.startsWith('median_amount|')
            && !h.startsWith('10th_percentile|') && !h.startsWith('90th_percentile|')
            && !h.startsWith('count|') && !h.startsWith('additional_payer_notes|'));
        }
        return;
      }

      if (!discardedFirst) {
        // Starting mid-file means this first row is likely a truncated
        // fragment of whatever line startByte landed in -- throw it away
        // rather than risk a corrupted sample.
        discardedFirst = true;
        return;
      }

      if (rowCount >= PER_WINDOW_ROW_CAP || rowCount >= MAX_ITEMS_SCANNED) {
        csvParser.destroy();
        return;
      }
      rowCount++;

      const found = extractSamples(row, localHeaderMap);
      let interesting = 0;
      for (const s of found) {
        samples.push(s);
        if (EXPECTED_PATTERN[s.codeType]) interesting++;
      }

      interestingCount += interesting;
      if (interestingCount >= TARGET_INTERESTING_SAMPLES) {
        csvParser.destroy();
      }
    });

    const finish = () => resolve({ layout, samples, rowCount, unmapped, columnCount: headers?.length || 0, headerMap: localHeaderMap });
    csvParser.on('end', finish);
    csvParser.on('close', finish);
    csvParser.on('error', reject);
  });
}

async function preflightCsv(filepath) {
  const fileSize = statSync(filepath).size;

  // First window finds the header and establishes headerMap/layout.
  const first = await scanCsvWindow(filepath, 0, null);

  const allSamples = [...first.samples];
  let rowCount = first.rowCount;

  // Additional windows spread across the rest of the file, reusing the
  // same headerMap (CSV files don't change schema mid-file). A byte offset
  // can land inside a quoted field, which csv-parse treats as a hard error
  // rather than a discardable garbage row -- skip that window rather than
  // fail the whole check; the other windows still provide signal.
  for (const frac of WINDOW_FRACTIONS.slice(1)) {
    const startByte = Math.floor(fileSize * frac);
    try {
      const window = await scanCsvWindow(filepath, startByte, first.headerMap);
      allSamples.push(...window.samples);
      rowCount += window.rowCount;
    } catch (err) {
      console.log(`  (window at ${(frac * 100).toFixed(0)}% of file skipped -- landed on a malformed boundary: ${err.message})`);
    }
  }

  return { layout: first.layout, samples: allSamples, rowCount, unmapped: first.unmapped, columnCount: first.columnCount };
}

async function preflightJson(filepath) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let itemCount = 0;
    let interestingCount = 0;

    const pipeline = chain([
      createReadStream(filepath),
      jsonParser(),
      pick({ filter: 'standard_charge_information' }),
      streamArray(),
    ]);

    pipeline.on('data', ({ value: item }) => {
      if (itemCount >= MAX_ITEMS_SCANNED) {
        pipeline.destroy();
        return;
      }
      itemCount++;
      for (const c of item.code_information || []) {
        if (c.code && c.type) {
          const upper = c.type.toUpperCase();
          samples.push({ code: c.code, codeType: upper });
          if (EXPECTED_PATTERN[upper]) interestingCount++;
        }
      }

      if (interestingCount >= TARGET_INTERESTING_SAMPLES) {
        pipeline.destroy();
      }
    });

    pipeline.on('end', () => resolve({ layout: 'n/a (JSON, nested per-item)', samples, rowCount: itemCount, unmapped: [], columnCount: null }));
    pipeline.on('close', () => resolve({ layout: 'n/a (JSON, nested per-item)', samples, rowCount: itemCount, unmapped: [], columnCount: null }));
    pipeline.on('error', reject);
  });
}

async function main() {
  const hospitalId = process.argv[2];
  if (!hospitalId) {
    console.log('Usage: npm run preflight -- <hospital-id>');
    process.exit(1);
  }

  const csvPath = path.join(RAW_DIR, `${hospitalId}.csv`);
  const jsonPath = path.join(RAW_DIR, `${hospitalId}.json`);

  let result;
  if (existsSync(csvPath)) {
    console.log(`[preflight] ${hospitalId}.csv`);
    result = await preflightCsv(csvPath);
  } else if (existsSync(jsonPath)) {
    console.log(`[preflight] ${hospitalId}.json`);
    result = await preflightJson(jsonPath);
  } else {
    console.log(`No raw file found for "${hospitalId}" in data/raw/. Run "npm run fetch-data" first.`);
    process.exit(1);
  }

  console.log(`Layout: ${result.layout}${result.columnCount ? ` (${result.columnCount} columns)` : ''}`);
  console.log(`Sampled ${result.rowCount.toLocaleString()} rows/items, ${result.samples.length.toLocaleString()} code/type pairs.`);
  if (result.unmapped.length > 0) {
    console.log(`Unrecognized columns (${result.unmapped.length}): ${result.unmapped.slice(0, 20).join(', ')}${result.unmapped.length > 20 ? ', ...' : ''}`);
  }

  const { byType, findings } = summarizeCodeSamples(result.samples);

  console.log('\nCode-type distribution in sample:');
  for (const [type, b] of Object.entries(byType)) {
    console.log(`  ${type}: ${b.total} (${(100 * b.matchesOwnPattern / b.total).toFixed(1)}% match expected shape)`);
  }

  if (findings.length === 0) {
    console.log('\nNo mislabeling risk detected in this sample. Safe to proceed with the schema-mapper step / full parse.');
  } else {
    console.log('\n*** MISLABELING RISK DETECTED ***');
    for (const f of findings) {
      console.log(`  ${f.type}: ${f.mismatchPct} of sampled codes don't match the expected ${f.type} shape.`);
      console.log(`    Examples: ${f.mismatchExamples.join(', ')}`);
      if (f.suspectedActualType.length > 0) {
        console.log(`    These look like: ${f.suspectedActualType.join(', ')} -- consider a promotion rule in data/column-maps/${hospitalId}.json`);
      }
    }
    console.log('\nReview before running the full parse -- see docs/adding-a-hospital.md.');
  }
}

main().catch(console.error);
