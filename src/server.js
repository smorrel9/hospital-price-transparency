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
  const { q, setting, payer, limit = 50, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query "q" is required' });
  }

  try {
    let query;
    let params;

    if (q.trim().length >= 3) {
      query = `
        SELECT p.*
        FROM procedures p
        JOIN procedures_fts fts ON p.id = fts.rowid
        WHERE procedures_fts MATCH ?
        ${setting ? 'AND p.setting = ?' : ''}
        ${payer ? 'AND p.payer_name LIKE ?' : ''}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `;
      params = [q.trim()];
    } else {
      query = `
        SELECT p.*
        FROM procedures p
        WHERE (p.description LIKE ? OR p.code LIKE ?)
        ${setting ? 'AND p.setting = ?' : ''}
        ${payer ? 'AND p.payer_name LIKE ?' : ''}
        LIMIT ? OFFSET ?
      `;
      params = [`%${q.trim()}%`, `%${q.trim()}%`];
    }

    if (setting) params.push(setting.toUpperCase());
    if (payer) params.push(`%${payer}%`);
    params.push(Number(limit), Number(offset));

    const results = db.prepare(query).all(...params);

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
    SELECT * FROM procedures
    WHERE code = ?
    ${setting ? 'AND setting = ?' : ''}
    ORDER BY payer_name, plan_name
  `;
  const params = [code];
  if (setting) params.push(setting.toUpperCase());

  const results = db.prepare(query).all(...params);

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

  res.json({
    code,
    description: results[0].description,
    setting: results[0].setting,
    gross_charge: results[0].gross_charge,
    cash_price: results[0].cash_price,
    min_negotiated: results[0].min_negotiated,
    max_negotiated: results[0].max_negotiated,
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
  const inpatient = db.prepare("SELECT COUNT(*) as count FROM procedures WHERE setting = 'INPATIENT'").get();
  const outpatient = db.prepare("SELECT COUNT(*) as count FROM procedures WHERE setting = 'OUTPATIENT'").get();

  res.json({
    total_records: total.count,
    payers: payers.count,
    unique_codes: codes.count,
    inpatient_records: inpatient.count,
    outpatient_records: outpatient.count,
  });
});

app.listen(PORT, () => {
  console.log(`Hospital Price Transparency API running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
