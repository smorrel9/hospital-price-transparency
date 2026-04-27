/**
 * server.js
 * Express API for searching hospital pricing data.
 *
 * Endpoints:
 *   GET /api/search?q=knee+mri
 *   GET /api/procedure/:code
 *   GET /api/hospitals
 *   GET /api/payers
 *   GET /api/stats
 */

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'prices.db');
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// In production, serve the Vite-built frontend as static files
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'dist')));
}

/**
 * Flag rows where prices are per-unit multipliers rather than real dollar amounts.
 * Pattern: CDM codes with gross_charge <= 1.0 use percentage-based pricing where
 * the "dollar" values are actually multipliers of a base charge.
 */
function flagResults(rows) {
  return rows.map(row => ({
    ...row,
    is_percentage_based: row.code_type === 'CDM' && row.gross_charge != null && row.gross_charge <= 1.0,
  }));
}

let db;
let _needsFtsBuild = false;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Check if FTS needs building — done after listen() to not block startup
  _needsFtsBuild = db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='procedures_fts'"
  ).get().c === 0;
} catch (err) {
  console.warn(`Could not open database at ${DB_PATH}`);
  console.warn('Run "npm run setup" to download and process hospital data first.');
  console.warn('Starting in setup-only mode — API endpoints will return 503.');
  db = null;
}

// Middleware: return 503 if DB isn't ready
app.use('/api', (req, res, next) => {
  if (!db) return res.status(503).json({ error: 'Database not ready. Run npm run setup first.' });
  next();
});

/**
 * Sanitize a user query for FTS5 MATCH.
 * - Remove special FTS operators (-, :, ^, *, ~)
 * - Replace hyphens with spaces so "x-ray" becomes "x ray"
 * - Wrap each word in double quotes for exact token matching
 */
function sanitizeFts(q) {
  return q
    .replace(/[-:^~*"]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => `"${w}"`)
    .join(' ');
}

/**
 * GET /api/search
 * Full-text search across procedure descriptions and codes.
 *
 * Query params:
 *   q        - search term (required)
 *   setting  - INPATIENT or OUTPATIENT
 *   payer    - filter by payer name
 *   limit    - max results (default 50)
 *   offset   - pagination offset (default 0)
 */
app.get('/api/search', (req, res) => {
  const { q, setting, payer, hospital, limit = 50, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query "q" is required' });
  }

  try {
    // First, find CPT/HCPCS codes whose friendly names match the query
    // This lets "brain MRI" or "knee replacement" find the right codes
    const ftsQuery = sanitizeFts(q);
    let matchedCodes = [];
    if (ftsQuery.length > 0) {
      try {
        matchedCodes = db.prepare(
          `SELECT code FROM friendly_names_fts WHERE friendly_names_fts MATCH ? LIMIT 50`
        ).all(ftsQuery).map(r => r.code);
      } catch {}
    }

    let query;
    let params;

    const filters = [];
    const filterParams = [];
    if (hospital) { filters.push('AND p.hospital_id = ?'); filterParams.push(hospital); }
    if (setting) { filters.push('AND p.setting = ?'); filterParams.push(setting.toUpperCase()); }
    if (payer) { filters.push('AND p.payer_name LIKE ?'); filterParams.push(`%${payer}%`); }
    const filterClause = filters.join(' ');

    if (q.trim().length >= 3) {
      if (matchedCodes.length > 0) {
        // Friendly-name matches first (CPT/HCPCS with readable names),
        // then FTS text matches on raw descriptions
        query = `
          SELECT * FROM (
            SELECT p.*, fn.friendly_name, 1 as source_rank
            FROM procedures p
            LEFT JOIN friendly_names fn ON p.code = fn.code
            WHERE p.code IN (${matchedCodes.map(() => '?').join(',')})
            ${filterClause}
            UNION ALL
            SELECT p.*, fn.friendly_name, 2 as source_rank
            FROM procedures p
            JOIN procedures_fts fts ON p.id = fts.rowid
            LEFT JOIN friendly_names fn ON p.code = fn.code
            WHERE procedures_fts MATCH ?
            AND p.code NOT IN (${matchedCodes.map(() => '?').join(',')})
            ${filterClause}
          ) ORDER BY source_rank LIMIT ? OFFSET ?
        `;
        params = [
          ...matchedCodes, ...filterParams,
          ftsQuery, ...matchedCodes, ...filterParams,
        ];
      } else {
        query = `
          SELECT p.*, fn.friendly_name
          FROM procedures p
          JOIN procedures_fts fts ON p.id = fts.rowid
          LEFT JOIN friendly_names fn ON p.code = fn.code
          WHERE procedures_fts MATCH ?
          ${filterClause}
          ORDER BY rank
          LIMIT ? OFFSET ?
        `;
        params = [ftsQuery, ...filterParams];
      }
    } else {
      query = `
        SELECT p.*, fn.friendly_name
        FROM procedures p
        LEFT JOIN friendly_names fn ON p.code = fn.code
        WHERE (p.description LIKE ? OR p.code LIKE ?)
        ${filterClause}
        LIMIT ? OFFSET ?
      `;
      params = [`%${q.trim()}%`, `%${q.trim()}%`, ...filterParams];
    }

    params.push(Number(limit), Number(offset));

    const results = flagResults(db.prepare(query).all(...params));

    res.json({
      query: q,
      count: results.length,
      offset: Number(offset),
      results,
    });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

/**
 * GET /api/procedure/:code
 * Get all pricing for a specific billing code across payers.
 */
app.get('/api/procedure/:code', (req, res) => {
  const { code } = req.params;
  const { setting } = req.query;

  let query = `
    SELECT p.*, fn.friendly_name
    FROM procedures p
    LEFT JOIN friendly_names fn ON p.code = fn.code
    WHERE p.code = ?
    ${setting ? 'AND p.setting = ?' : ''}
    ORDER BY p.payer_name, p.plan_name
  `;
  const params = [code];
  if (setting) params.push(setting.toUpperCase());

  const results = flagResults(db.prepare(query).all(...params));

  if (results.length === 0) {
    return res.status(404).json({ error: `No pricing found for code: ${code}` });
  }

  // Group by payer
  const grouped = {};
  for (const row of results) {
    const key = row.payer_name || 'Self-Pay / Uninsured';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  const anyPercentageBased = results.some(r => r.is_percentage_based);

  // Look up official CMS Medicare rate for this code
  let medicare = null;
  try {
    const medicareRow = db.prepare(
      `SELECT facility_rate, nonfac_rate, work_rvu, conv_factor, locality, year
       FROM medicare_rates WHERE code = ?`
    ).get(code);
    if (medicareRow) {
      medicare = {
        facility_rate: medicareRow.facility_rate,
        nonfac_rate: medicareRow.nonfac_rate,
        locality: medicareRow.locality,
        year: medicareRow.year,
        source: 'CMS Physician Fee Schedule',
      };
    }
  } catch {}

  res.json({
    code,
    description: results[0].description,
    friendly_name: results[0].friendly_name || null,
    setting: results[0].setting,
    gross_charge: results[0].gross_charge,
    cash_price: results[0].cash_price,
    min_negotiated: results[0].min_negotiated,
    max_negotiated: results[0].max_negotiated,
    is_percentage_based: anyPercentageBased,
    payers: grouped,
    medicare,
  });
});

/**
 * GET /api/hospitals
 * List all hospitals in the database.
 */
app.get('/api/hospitals', (req, res) => {
  const hospitals = db.prepare(`
    SELECT DISTINCT hospital_id,
      COUNT(*) as record_count,
      COUNT(DISTINCT code) as unique_codes,
      COUNT(DISTINCT payer_name) as payer_count
    FROM procedures
    GROUP BY hospital_id
  `).all();

  res.json({ hospitals });
});

/**
 * GET /api/payers
 * List all payers/plans, optionally filtered by setting.
 */
app.get('/api/payers', (req, res) => {
  const { setting } = req.query;

  let query = `
    SELECT DISTINCT payer_name, plan_name, COUNT(*) as rate_count
    FROM procedures
    WHERE payer_name IS NOT NULL
    ${setting ? 'AND setting = ?' : ''}
    GROUP BY payer_name, plan_name
    ORDER BY payer_name, plan_name
  `;
  const params = setting ? [setting.toUpperCase()] : [];

  const payers = db.prepare(query).all(...params);
  res.json({ payers });
});

/**
 * GET /api/stats
 * Database summary statistics.
 */
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM procedures').get();
  const payers = db.prepare('SELECT COUNT(DISTINCT payer_name) as count FROM procedures WHERE payer_name IS NOT NULL').get();
  const codes = db.prepare('SELECT COUNT(DISTINCT code) as count FROM procedures WHERE code IS NOT NULL').get();
  const settings = db.prepare("SELECT setting, COUNT(*) as count FROM procedures GROUP BY setting").all();
  const settingCounts = {};
  for (const s of settings) settingCounts[s.setting || 'UNKNOWN'] = s.count;

  res.json({
    total_records: total.count,
    payers: payers.count,
    unique_codes: codes.count,
    settings: settingCounts,
  });
});

/**
 * GET /api/autocomplete
 * Suggest procedures by searching friendly_names via FTS5 + LIKE fallback.
 *
 * Query params:
 *   q     - search term (required)
 *   limit - max results (default 10)
 */
app.get('/api/autocomplete', (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query "q" is required' });
  }

  try {
    const maxResults = Number(limit);
    const seen = new Map(); // code -> row, for deduplication

    // 1. FTS5 prefix search
    const ftsTokens = q
      .replace(/[-:^~*"]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);

    if (ftsTokens.length > 0) {
      const ftsQuery = ftsTokens.map(w => `"${w}"*`).join(' ');
      try {
        const ftsRows = db.prepare(`
          SELECT fn.code, fn.code_type, fn.friendly_name, fn.original_description
          FROM friendly_names_fts fts
          JOIN friendly_names fn ON fn.code = fts.code
          WHERE friendly_names_fts MATCH ?
          LIMIT ?
        `).all(ftsQuery, maxResults * 3);

        for (const row of ftsRows) {
          if (!seen.has(row.code)) seen.set(row.code, row);
        }
      } catch {}
    }

    // 2. LIKE fallback if we don't have enough results
    if (seen.size < maxResults) {
      const likePattern = `%${q.trim()}%`;
      const likeRows = db.prepare(`
        SELECT code, code_type, friendly_name, original_description
        FROM friendly_names
        WHERE friendly_name LIKE ? OR original_description LIKE ? OR search_terms LIKE ?
        LIMIT ?
      `).all(likePattern, likePattern, likePattern, maxResults * 3);

      for (const row of likeRows) {
        if (!seen.has(row.code)) seen.set(row.code, row);
      }
    }

    const suggestions = Array.from(seen.values()).slice(0, maxResults).map(r => ({
      code: r.code,
      code_type: r.code_type,
      friendly_name: r.friendly_name,
      original_description: r.original_description,
    }));

    res.json({ suggestions });
  } catch (err) {
    console.error('Autocomplete error:', err.message);
    res.status(500).json({ error: 'Autocomplete failed', detail: err.message });
  }
});

/**
 * Build payer categories at startup (cached — the 36M row DISTINCT is slow).
 */
let _payerCategoriesCache = null;
let _payerCacheBuilding = false;
function buildPayerCategories() {
  if (_payerCategoriesCache) return _payerCategoriesCache;

  _payerCacheBuilding = true;
  console.log('Building payer categories cache...');
  const rows = db.prepare(`
    SELECT DISTINCT payer_name, hospital_id
    FROM procedures
    WHERE payer_name IS NOT NULL
  `).all();

  const categoryPatterns = [
    { category: 'BCBS',      test: n => /BCBS|Blue\s*Cross|BLUE/i.test(n) },
    { category: 'Aetna',     test: n => /AETNA|Aetna/i.test(n) },
    { category: 'United',    test: n => /UNITED|UHC|Uhc/i.test(n) },
    { category: 'Cigna',     test: n => /CIGNA|Cigna/i.test(n) },
    { category: 'Humana',    test: n => /HUMANA|Humana/i.test(n) },
    { category: 'Medicare',  test: n => /MEDICARE|Medicare/i.test(n) },
    { category: 'Medicaid',  test: n => /MEDICAID|Medicaid|STAR|CHIP/i.test(n) },
  ];

  const groups = {};
  for (const { payer_name, hospital_id } of rows) {
    let matched = false;
    for (const { category, test } of categoryPatterns) {
      if (test(payer_name)) {
        if (!groups[category]) groups[category] = {};
        if (!groups[category][payer_name]) groups[category][payer_name] = new Set();
        groups[category][payer_name].add(hospital_id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!groups['Other']) groups['Other'] = {};
      if (!groups['Other'][payer_name]) groups['Other'][payer_name] = new Set();
      groups['Other'][payer_name].add(hospital_id);
    }
  }

  _payerCategoriesCache = Object.entries(groups).map(([category, payers]) => ({
    category,
    payers: Object.entries(payers).map(([payer_name, hospitalSet]) => ({
      payer_name,
      hospital_ids: Array.from(hospitalSet),
    })),
  }));

  _payerCacheBuilding = false;
  console.log(`  ${_payerCategoriesCache.length} categories, ${rows.length} payer/hospital combos`);
  return _payerCategoriesCache;
}

/**
 * GET /api/payer-categories
 * Return payer names grouped into broad insurance categories.
 */
app.get('/api/payer-categories', (req, res) => {
  try {
    if (_payerCacheBuilding) {
      return res.json({ categories: [], loading: true });
    }
    res.json({ categories: buildPayerCategories() });
  } catch (err) {
    console.error('Payer categories error:', err.message);
    res.status(500).json({ error: 'Failed to load payer categories', detail: err.message });
  }
});

// SPA catchall: serve index.html for any non-API route in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hospital Price Transparency API running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);

  // Build FTS indexes if missing (runs after listen so health checks pass)
  if (db && _needsFtsBuild) {
    console.log('FTS indexes not found — building (this may take a few minutes)...');
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
        description, code, rev_code, payer_name, content='procedures', content_rowid='id'
      )`);
      db.exec("INSERT INTO procedures_fts(procedures_fts) VALUES('rebuild')");
      console.log('  procedures_fts: done');

      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS friendly_names_fts USING fts5(
        friendly_name, original_description, search_terms, code, content='friendly_names', content_rowid='rowid'
      )`);
      db.exec("INSERT INTO friendly_names_fts(friendly_names_fts) VALUES('rebuild')");
      console.log('  friendly_names_fts: done');

      db.exec(`CREATE TRIGGER IF NOT EXISTS procedures_ai AFTER INSERT ON procedures BEGIN
        INSERT INTO procedures_fts(rowid, description, code, rev_code, payer_name)
        VALUES (new.id, new.description, new.code, new.rev_code, new.payer_name);
      END`);
      console.log('FTS indexes built successfully.');
    } catch (e) {
      console.error('FTS build failed:', e.message);
    }
  }
});
