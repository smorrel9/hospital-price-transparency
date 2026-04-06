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
    // Server returns a ZIP despite the .csv extension
    compressed: true,
  },
];

async function downloadFile(hospital) {
  const ext = hospital.compressed ? '.zip' : '.csv';
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
