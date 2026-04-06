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
try {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error(`Could not open database at ${DB_PATH}`);
  console.error('Run "npm run setup" to download and process hospital data first.');
  process.exit(1);
}

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

// SPA catchall: serve index.html for any non-API route in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Hospital Price Transparency API running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
