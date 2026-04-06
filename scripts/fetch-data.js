/**
 * fetch-data.js
 * Downloads hospital MRF (machine-readable file) CSVs.
 * Handles ZIP-compressed files (Ascension serves a ZIP, not raw CSV).
 *
 * Usage: npm run fetch-data
 */

import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { execSync } from 'child_process';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');

const HOSPITALS = [
  {
    id: 'ascension-seton-austin',
    name: 'Ascension Seton Medical Center Austin',
    url: 'https://healthcare.ascension.org/-/media/project/ascension/healthcare/price-transparency-files/tx-csv/741109643-1164526786_ascension-seton_standardcharges.csv',
    compressed: true,
    format: 'csv',
  },
  {
    id: 'dell-seton-austin',
    name: 'Dell Seton Medical Center at UT Austin',
    url: 'https://healthcare.ascension.org/-/media/project/ascension/healthcare/price-transparency-files/tx-csv/741109643-1093810327_ascension-seton_standardcharges.csv',
    compressed: true,
    format: 'csv',
  },
  {
    id: 'bsw-austin',
    name: 'Baylor Scott & White Medical Center Austin',
    url: 'https://wadcdn.azureedge.net/bswhealth/com/siteassets/pricing-transparency/813040663_baylor-scott--white-medical-center--austin_standardcharges.csv',
    compressed: false,
    format: 'csv',
  },
  {
    id: 'st-davids-austin',
    name: "St. David's Medical Center Austin",
    url: "https://stctrprodsnsvc00455826e6.blob.core.windows.net/pt-final-posting-files/74-2781812_ST.-DAVID'S-MEDICAL-CENTER_standardcharges.json?si=pt-json-access-policy&spr=https&sv=2024-11-04&sr=c&sig=o5IofreS%2F7ETlsnhPakPWCwHVVUZRobywQ5wUKGjVuQ%3D",
    compressed: false,
    format: 'json',
  },
];

async function downloadFile(hospital) {
  const fileExt = hospital.format === 'json' ? '.json' : '.csv';
  const ext = hospital.compressed ? '.zip' : fileExt;
  const outPath = path.join(RAW_DIR, `${hospital.id}${ext}`);

  console.log(`[fetch] ${hospital.name}`);
  console.log(`  URL: ${hospital.url}`);

  const res = await fetch(hospital.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HospitalPriceTransparency/1.0)',
      'Accept': 'text/csv,application/zip,*/*',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${hospital.url}`);
  }

  const dest = createWriteStream(outPath);
  await pipeline(res.body, dest);

  const sizeMB = (dest.bytesWritten / 1024 / 1024).toFixed(1);
  console.log(`  Downloaded: ${sizeMB} MB -> ${path.basename(outPath)}`);

  // Extract ZIP if needed
  if (hospital.compressed) {
    console.log('  Extracting ZIP...');
    execSync(`unzip -o -d "${RAW_DIR}" "${outPath}"`, { stdio: 'pipe' });
    console.log('  Extracted.');
  }

  return outPath;
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });

  for (const hospital of HOSPITALS) {
    try {
      await downloadFile(hospital);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log('\nDone. Run "npm run parse-data" next.');
}

main().catch(console.error);
