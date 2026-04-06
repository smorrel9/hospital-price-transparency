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

import { createReadStream, createWriteStream, mkdirSync, readdirSync } from 'fs';
import { parse } from 'csv-parse';
import path from 'path';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const PARSED_DIR = path.join(process.cwd(), 'data', 'parsed');

/**
 * Map the real pipe-delimited CMS column names to our internal field names.
 * The CSV headers look like: description, code|1, code|1|type, standard_charge|gross, etc.
 */
const COLUMN_MAP = {
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
function parseNum(val) {
  if (!val || val === '' || val === 'N/A' || val === '-') return null;
  const cleaned = String(val).replace(/[$,\s"]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse a price specifically — round to cents.
 */
function parsePrice(val) {
  const num = parseNum(val);
  return num !== null ? Math.round(num * 100) / 100 : null;
}

/**
 * Stream-parse a single CSV file, writing NDJSON output.
 */
async function parseFile(filepath) {
  const basename = path.basename(filepath);
  console.log(`[parse] ${basename}`);

  const outName = basename.replace('.csv', '.ndjson');
  const outPath = path.join(PARSED_DIR, outName);
  const outStream = createWriteStream(outPath);

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
          // Build index map: column position -> our field name
          headerMap = headers.map(h => COLUMN_MAP[h] || null);

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

      // Pick the best code across all code slots (code|1 through code|4).
      // Prefer CPT/HCPCS > MS-DRG/APR-DRG > RC > CDM.
      // BSW puts codes in varying positions — CPT might be in code|2 or code|3.
      const codeSlots = [
        { code: record.code, type: record.code_type },
        { code: record.rev_code, type: record.rev_code_type },
        { code: record.hcpcs_code, type: record.hcpcs_code_type },
      ].filter(s => s.code && s.type);

      const priority = { CPT: 1, HCPCS: 1, 'MS-DRG': 2, 'APR-DRG': 2, 'TRIS-DRG': 2, RC: 3, CDM: 4 };
      codeSlots.sort((a, b) => (priority[a.type?.toUpperCase()] || 5) - (priority[b.type?.toUpperCase()] || 5));

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
      outStream.end(() => {
        console.log(`  Total: ${dataRows} data rows, ${keptRows} kept`);
        console.log(`  Output: ${outName}`);
        resolve({ dataRows, keptRows, outPath });
      });
    });

    csvParser.on('error', (err) => {
      outStream.end();
      console.error(`  Error at row ${rowNum}: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  mkdirSync(PARSED_DIR, { recursive: true });

  const files = readdirSync(RAW_DIR).filter(f => f.endsWith('.csv'));
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

main().catch(console.error);
