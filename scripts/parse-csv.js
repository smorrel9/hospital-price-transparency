/**
 * parse-csv.js
 * Parses raw Ascension Seton hospital pricing CSV into normalized NDJSON.
 *
 * Real schema (CMS v3.0.0 tall format):
 *   Row 1: Hospital metadata headers
 *   Row 2: Hospital metadata values
 *   Row 3: Data column headers (pipe-delimited names like "code|1", "standard_charge|gross")
 *   Row 4+: Data rows (one row per procedure/payer combination)
 *
 * The uncompressed CSV is ~4 GB, so we:
 *   - Stream input with csv-parse
 *   - Write NDJSON (one JSON object per line) instead of a single giant array
 *   - Skip the 2 metadata rows, then use row 3 as headers
 *
 * Usage: npm run parse-data
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { parse } from 'csv-parse';
import path from 'path';
import { fileURLToPath } from 'url';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const PARSED_DIR = path.join(process.cwd(), 'data', 'parsed');
const COLUMN_MAPS_DIR = path.join(process.cwd(), 'data', 'column-maps');

// Default code-type promotion rules, applied after code-slot selection.
// Per-hospital overrides (data/column-maps/<id>.json) can add more.
export const DEFAULT_PROMOTIONS = [
  // HCPCS Level II is always alphanumeric (letter + 4 digits); a purely
  // 5-digit numeric code labeled HCPCS is actually CPT. BSW's file
  // consistently mislabels CPT codes as HCPCS -- this promotes them.
  { from: 'HCPCS', to: 'CPT', pattern: '^\\d{5}$' },
];

/**
 * Detect CMS v3.0.0 layout from a hospital file's header row.
 * "tall" = one row per procedure/payer/plan, generic payer_name/plan_name columns.
 * "wide" = one row per procedure, payer+plan baked into column names
 * (e.g. standard_charge|Aetna|HMO_Inpatient|negotiated_dollar). Wide-format
 * files need scripts/parse-csv-wide.js, not this script.
 */
export function detectLayout(headers) {
  return headers.includes('payer_name') ? 'tall' : 'wide';
}

/**
 * Load the per-hospital column-map override, if one exists.
 * Returns { columnMap: {}, promotions: [] } -- both default to empty/default.
 */
export function loadOverride(hospitalId) {
  const overridePath = path.join(COLUMN_MAPS_DIR, `${hospitalId}.json`);
  if (!existsSync(overridePath)) {
    return { columnMap: {}, promotions: DEFAULT_PROMOTIONS };
  }
  const override = JSON.parse(readFileSync(overridePath, 'utf-8'));
  return {
    columnMap: override.columnMap || {},
    promotions: [...DEFAULT_PROMOTIONS, ...(override.promotions || [])],
  };
}

/**
 * Map the real pipe-delimited CMS column names to our internal field names.
 * The CSV headers look like: description, code|1, code|1|type, standard_charge|gross, etc.
 */
export const COLUMN_MAP = {
  'description': 'description',
  'code|1': 'code',
  'code|1|type': 'code_type',
  'code|2': 'rev_code',
  'code|2|type': 'rev_code_type',
  'code|3': 'hcpcs_code',       // BSW: cross-reference HCPCS code
  'code|3|type': 'hcpcs_code_type',
  'code|4': 'ndc_code',         // BSW: NDC drug code
  'code|4|type': 'ndc_code_type',
  'billing_class': 'billing_class', // BSW uses this alongside setting
  'modifiers': 'modifiers',
  'setting': 'setting',
  'drug_unit_of_measurement': 'drug_unit',
  'drug_type_of_measurement': 'drug_unit_type',
  'standard_charge|gross': 'gross_charge',
  'standard_charge|discounted_cash': 'cash_price',
  'payer_name': 'payer_name',
  'plan_name': 'plan_name',
  'standard_charge|negotiated_dollar': 'negotiated_rate',
  'standard_charge|negotiated_percentage': 'negotiated_percentage',
  'standard_charge|negotiated_algorithm': 'negotiated_algorithm',
  'standard_charge|methodology': 'methodology',
  'standard_charge|min': 'min_negotiated',
  'standard_charge|max': 'max_negotiated',
  'median_amount': 'median',
  '10th_percentile': 'p10',
  '90th_percentile': 'p90',
  'count': 'count',
  'additional_generic_notes': 'notes',
};

/**
 * Parse a numeric string, returning null for empty/invalid values.
 */
export function parseNum(val) {
  if (!val || val === '' || val === 'N/A' || val === '-') return null;
  const cleaned = String(val).replace(/[$,\s"]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse a price specifically — round to cents.
 */
export function parsePrice(val) {
  const num = parseNum(val);
  return num !== null ? Math.round(num * 100) / 100 : null;
}

/**
 * Pick the best code across all code slots (code|1 through code|4).
 * Prefer CPT/HCPCS > MS-DRG/APR-DRG > RC > CDM. BSW puts codes in varying
 * positions -- CPT might be in code|2 or code|3. Row-level, so this applies
 * identically whether the source file is tall or wide format.
 */
export function selectCode(record, promotions) {
  const codeSlots = [
    { code: record.code, type: record.code_type },
    { code: record.rev_code, type: record.rev_code_type },
    { code: record.hcpcs_code, type: record.hcpcs_code_type },
    { code: record.ndc_code, type: record.ndc_code_type },
  ].filter(s => s.code && s.type);

  const priority = { CPT: 1, HCPCS: 1, 'MS-DRG': 2, 'APR-DRG': 2, 'TRIS-DRG': 2, NDC: 3, RC: 4, CDM: 5 };
  codeSlots.sort((a, b) => (priority[a.type?.toUpperCase()] || 6) - (priority[b.type?.toUpperCase()] || 6));

  let code = record.code;
  let codeType = record.code_type;
  let revCode = record.rev_code;

  if (codeSlots.length > 0) {
    const best = codeSlots[0];
    code = best.code;
    codeType = best.type?.toUpperCase();
    // Find an RC code for rev_code if it's not the primary
    const rcSlot = codeSlots.find(s => s.type?.toUpperCase() === 'RC' && s.code !== code);
    revCode = rcSlot?.code || (record.code_type?.toUpperCase() === 'RC' ? record.code : record.rev_code);
  }

  // Apply code-type promotion rules (default + any per-hospital override).
  for (const rule of promotions) {
    if (codeType === rule.from && code && new RegExp(rule.pattern).test(code)) {
      codeType = rule.to;
      break;
    }
  }

  return { code, codeType, revCode };
}

/**
 * Stream-parse a single CSV file, writing NDJSON output.
 */
async function parseFile(filepath) {
  const basename = path.basename(filepath);
  const hospitalId = basename.replace('.csv', '');
  console.log(`[parse] ${basename}`);

  const { columnMap: overrideMap, promotions } = loadOverride(hospitalId);
  if (Object.keys(overrideMap).length > 0) {
    console.log(`  Using column-map override: data/column-maps/${hospitalId}.json`);
  }

  const outName = basename.replace('.csv', '.ndjson');
  const outPath = path.join(PARSED_DIR, outName);
  // Opened lazily, only once the layout check confirms this file is tall --
  // otherwise a wide-format file would truncate an existing good .ndjson
  // for no reason before being skipped.
  let outStream = null;

  return new Promise((resolve, reject) => {
    let headers = null;
    let headerMap = null; // index -> our field name
    let rowNum = 0;
    let dataRows = 0;
    let keptRows = 0;
    let metadataRows = 0;

    const csvParser = createReadStream(filepath)
      .pipe(parse({
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }));

    csvParser.on('data', (row) => {
      rowNum++;

      // Find the data header row.
      // Metadata rows (1-2) won't have both "description" and "charge" keywords.
      if (!headers) {
        const lower = row.map(c => c.toLowerCase().trim());
        const hasDescription = lower.some(c => c === 'description');
        const hasCharge = lower.some(c => c.includes('charge') || c.includes('price'));

        if (hasDescription && hasCharge) {
          headers = row.map(c => c.trim());

          const layout = detectLayout(headers);
          if (layout === 'wide') {
            console.log(`  Detected wide-format layout (payer/plan baked into column names, ${headers.length} columns) -- this file needs "npm run parse-data-wide", not this script. Skipping (existing output, if any, left untouched).`);
            resolve({ dataRows: 0, keptRows: 0, outPath, skipped: 'wide-layout' });
            csvParser.destroy();
            return;
          }

          outStream = createWriteStream(outPath);

          // Build index map: column position -> our field name.
          // Per-hospital override takes precedence over the default map.
          headerMap = headers.map(h => overrideMap[h] || COLUMN_MAP[h] || null);

          const mappedCount = headerMap.filter(Boolean).length;
          console.log(`  Header found at row ${rowNum}`);
          console.log(`  Columns: ${headers.length} (${mappedCount} mapped)`);
          console.log(`  Skipped ${metadataRows} metadata row(s)`);

          // Log any unmapped columns for debugging
          const unmapped = headers.filter(h => !COLUMN_MAP[h]);
          if (unmapped.length > 0) {
            console.log(`  Unmapped columns: ${unmapped.join(', ')}`);
          }
          return;
        } else {
          metadataRows++;
          return;
        }
      }

      dataRows++;

      // Build record from mapped columns only
      const record = {};
      for (let i = 0; i < row.length; i++) {
        const field = headerMap[i];
        if (field) record[field] = row[i] || null;
      }

      // Skip rows with no description and no code
      if (!record.description && !record.code) return;

      const { code, codeType, revCode } = selectCode(record, promotions);

      // Parse numeric fields
      const parsed = {
        description: record.description,
        code,
        code_type: codeType,
        rev_code: revCode,
        modifiers: record.modifiers || null,
        setting: record.setting || null,
        gross_charge: parsePrice(record.gross_charge),
        cash_price: parsePrice(record.cash_price),
        payer_name: record.payer_name || null,
        plan_name: record.plan_name || null,
        negotiated_rate: parsePrice(record.negotiated_rate),
        negotiated_percentage: parseNum(record.negotiated_percentage),
        negotiated_algorithm: record.negotiated_algorithm || null,
        methodology: record.methodology || null,
        min_negotiated: parsePrice(record.min_negotiated),
        max_negotiated: parsePrice(record.max_negotiated),
        notes: record.notes || null,
      };

      outStream.write(JSON.stringify(parsed) + '\n');
      keptRows++;

      // Progress logging every 500k rows
      if (dataRows % 500000 === 0) {
        console.log(`  ... ${(dataRows / 1000000).toFixed(1)}M rows processed, ${keptRows} kept`);
      }
    });

    csvParser.on('end', () => {
      if (!outStream) {
        console.log('  No tall-format header row found -- nothing parsed.');
        resolve({ dataRows: 0, keptRows: 0, outPath, skipped: 'no-header-found' });
        return;
      }
      outStream.end(() => {
        console.log(`  Total: ${dataRows} data rows, ${keptRows} kept`);
        console.log(`  Output: ${outName}`);
        resolve({ dataRows, keptRows, outPath });
      });
    });

    csvParser.on('error', (err) => {
      if (outStream) outStream.end();
      console.error(`  Error at row ${rowNum}: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  mkdirSync(PARSED_DIR, { recursive: true });

  // Single-hospital mode: `node scripts/parse-csv.js <hospital_id>` parses
  // just that one raw file instead of rescanning all of data/raw/. Mirrors
  // seed-db.js's per-hospital upsert -- re-parsing every hospital's raw
  // file (some multi-GB) every time one hospital changes was the same
  // "redoes work across the whole dataset" pattern seed-db.js had.
  const targetHospital = process.argv[2];
  let files;
  if (targetHospital) {
    const targetFile = `${targetHospital}.csv`;
    if (!existsSync(path.join(RAW_DIR, targetFile))) {
      console.error(`No raw CSV found for "${targetHospital}" at data/raw/${targetFile}`);
      process.exitCode = 1;
      return;
    }
    files = [targetFile];
  } else {
    files = readdirSync(RAW_DIR).filter(f => f.endsWith('.csv'));
  }

  if (files.length === 0) {
    console.log('No CSV files found in data/raw/. Run "npm run fetch-data" first.');
    return;
  }

  for (const file of files) {
    const filepath = path.join(RAW_DIR, file);
    await parseFile(filepath);
    console.log();
  }

  console.log('Done. Run "npm run seed-db" next.');
}

// Only run when executed directly (`node scripts/parse-csv.js`), not when
// this module is imported for its exports (parse-csv-wide.js does exactly
// that) -- otherwise importing it re-triggers a full pipeline run as a
// side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
