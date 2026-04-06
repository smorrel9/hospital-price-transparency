/**
 * parse-json.js
 * Parses HCA-format JSON hospital pricing files into normalized NDJSON.
 *
 * HCA (St. David's) uses CMS v3.0.0 JSON format with nested structure.
 * Files can be 1GB+ so we use stream-json to parse without loading into memory.
 *
 * Usage: npm run parse-json
 */

import { createReadStream, createWriteStream, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { parser as jsonParser } from 'stream-json/parser.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { pick } from 'stream-json/filters/pick.js';
import chain from 'stream-chain';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const PARSED_DIR = path.join(process.cwd(), 'data', 'parsed');

function parsePrice(val) {
  if (val == null || val === '') return null;
  const num = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

/**
 * Stream-parse an HCA JSON file using stream-json.
 * We use pick() to extract items from the standard_charge_information array
 * one at a time without loading the full file.
 */
async function parseFile(filepath) {
  const basename = path.basename(filepath);
  console.log(`[parse-json] ${basename}`);

  const outName = basename.replace('.json', '.ndjson');
  const outPath = path.join(PARSED_DIR, outName);
  const outStream = createWriteStream(outPath);

  // stream-json's pick + streamArray lets us iterate over
  // standard_charge_information[] items one at a time
  return new Promise((resolve, reject) => {
    let itemCount = 0;
    let keptRows = 0;

    const pipeline = chain([
      createReadStream(filepath),
      jsonParser(),
      pick({ filter: 'standard_charge_information' }),
      streamArray(),
    ]);

    pipeline.on('data', ({ value: item }) => {
      itemCount++;

      const description = item.description?.trim() || null;

      // Extract codes — prefer CPT/HCPCS, fallback to CDM
      const codes = item.code_information || [];
      let code = null, codeType = null, revCode = null;
      for (const c of codes) {
        const t = (c.type || '').toUpperCase();
        if (['CPT', 'HCPCS', 'MS-DRG', 'DRG', 'APC'].includes(t)) {
          code = c.code;
          codeType = t;
        } else if (t === 'RC') {
          revCode = c.code;
        } else if (!code) {
          code = c.code;
          codeType = t || 'CDM';
        }
      }

      const charges = item.standard_charges || [];
      for (const charge of charges) {
        const setting = (charge.setting || 'both').toUpperCase();
        const grossCharge = parsePrice(charge.gross_charge);
        const cashPrice = parsePrice(charge.discounted_cash);
        const minNeg = parsePrice(charge.minimum);
        const maxNeg = parsePrice(charge.maximum);

        const payers = charge.payers_information || [];
        if (payers.length === 0) {
          const parsed = {
            description, code, code_type: codeType, rev_code: revCode,
            modifiers: null, setting, gross_charge: grossCharge, cash_price: cashPrice,
            payer_name: null, plan_name: null,
            negotiated_rate: null, negotiated_percentage: parsePrice(charge.standard_charge_percentage),
            negotiated_algorithm: charge.standard_charge_algorithm || null,
            methodology: null, min_negotiated: minNeg, max_negotiated: maxNeg, notes: null,
          };
          if (parsed.description || parsed.code) {
            outStream.write(JSON.stringify(parsed) + '\n');
            keptRows++;
          }
        } else {
          for (const payer of payers) {
            const parsed = {
              description, code, code_type: codeType, rev_code: revCode,
              modifiers: null, setting, gross_charge: grossCharge, cash_price: cashPrice,
              payer_name: payer.payer_name || null, plan_name: payer.plan_name || null,
              negotiated_rate: parsePrice(payer.standard_charge_dollar),
              negotiated_percentage: parsePrice(payer.standard_charge_percentage),
              negotiated_algorithm: payer.standard_charge_algorithm || null,
              methodology: payer.methodology || null,
              min_negotiated: minNeg, max_negotiated: maxNeg,
              notes: payer.additional_payer_notes || null,
            };
            if (parsed.description || parsed.code) {
              outStream.write(JSON.stringify(parsed) + '\n');
              keptRows++;
            }
          }
        }
      }

      if (itemCount % 10000 === 0) {
        console.log(`  ... ${itemCount} procedures, ${(keptRows / 1000000).toFixed(1)}M rows`);
      }
    });

    pipeline.on('end', () => {
      outStream.end(() => {
        console.log(`  Total: ${itemCount} procedures -> ${keptRows} rate rows`);
        console.log(`  Output: ${outName}`);
        resolve({ dataRows: itemCount, keptRows, outPath });
      });
    });

    pipeline.on('error', (err) => {
      outStream.end();
      console.error(`  Error: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  mkdirSync(PARSED_DIR, { recursive: true });

  const files = readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No JSON files found in data/raw/.');
    return;
  }

  for (const file of files) {
    await parseFile(path.join(RAW_DIR, file));
    console.log();
  }

  console.log('Done.');
}

main().catch(console.error);
