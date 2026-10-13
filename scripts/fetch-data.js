/**
 * fetch-data.js
 * Downloads hospital MRF (machine-readable file) CSVs/JSON listed in
 * data/hospitals.json. Handles ZIP-compressed files (Ascension serves
 * a ZIP, not raw CSV) and renames the extracted file to <hospital-id>
 * so downstream scripts never need a filename-to-id lookup table.
 *
 * Usage: npm run fetch-data
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { execSync } from 'child_process';
import { RAW_DIR, MANIFEST_PATH } from './paths.js';

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

async function downloadFile(hospital) {
  const fileExt = hospital.format === 'json' ? '.json' : '.csv';
  const ext = hospital.compressed ? '.zip' : fileExt;
  const outPath = path.join(RAW_DIR, `${hospital.id}${ext}`);

  console.log(`[fetch] ${hospital.name}`);
  console.log(`  URL: ${hospital.source_url}`);

  const res = await fetch(hospital.source_url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HospitalPriceTransparency/1.0)',
      'Accept': 'text/csv,application/zip,*/*',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${hospital.source_url}`);
  }

  const dest = createWriteStream(outPath);
  await pipeline(res.body, dest);

  const sizeMB = (dest.bytesWritten / 1024 / 1024).toFixed(1);
  console.log(`  Downloaded: ${sizeMB} MB -> ${path.basename(outPath)}`);

  // Extract ZIP if needed, then rename whatever came out to <id><fileExt>
  // so it matches the raw filename convention non-zipped hospitals already use.
  if (hospital.compressed) {
    console.log('  Extracting ZIP...');
    const before = new Set(readdirSync(RAW_DIR));
    execSync(`unzip -o -d "${RAW_DIR}" "${outPath}"`, { stdio: 'pipe' });
    const after = readdirSync(RAW_DIR);
    const extracted = after.find(f => !before.has(f) && f.endsWith(fileExt));

    const finalPath = path.join(RAW_DIR, `${hospital.id}${fileExt}`);
    if (extracted) {
      renameSync(path.join(RAW_DIR, extracted), finalPath);
      console.log(`  Extracted and renamed: ${extracted} -> ${hospital.id}${fileExt}`);
    } else {
      console.log(`  Extracted, but could not identify the new ${fileExt} file -- check data/raw/ manually.`);
    }
    return finalPath;
  }

  return outPath;
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });

  const force = process.argv.includes('--force');
  const manifest = loadManifest();

  for (const hospital of manifest.hospitals) {
    if (!hospital.source_url) {
      console.log(`[fetch] ${hospital.name}: no source_url yet (status=${hospital.status}), skipping`);
      continue;
    }

    const fileExt = hospital.format === 'json' ? '.json' : '.csv';
    const finalPath = path.join(RAW_DIR, `${hospital.id}${fileExt}`);
    if (!force && existsSync(finalPath)) {
      console.log(`[fetch] ${hospital.name}: ${hospital.id}${fileExt} already on disk, skipping (use --force to re-download)`);
      continue;
    }

    try {
      await downloadFile(hospital);
      hospital.last_fetched_at = new Date().toISOString();
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  saveManifest(manifest);
  console.log('\nDone. Run "npm run parse-data" next.');
}

main().catch(console.error);
