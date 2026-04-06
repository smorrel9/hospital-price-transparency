# Database Architecture: Hospital Price Transparency Tool

## Overview

This document covers the recommended data storage strategy for scaling from a single-hospital SQLite proof of concept to a national Postgres deployment.

---

## Storage Strategy by Phase

| Phase | Hospitals | Stack | Est. Monthly Cost |
|---|---|---|---|
| Demo | 1-5 | SQLite on Fly.io (single instance) | $5-15 |
| Regional | 10-50 | Postgres on Railway or Supabase | $25-75 |
| State-wide | 50-500 | Postgres + read replica | $100-300 |
| National | 500+ | Managed Postgres (Neon, Supabase Pro) or DuckDB + Parquet on S3 | $300-1000+ |

**Key principle:** Do not store raw CSV or JSON files in the repository. Store parse/normalize scripts, a `hospitals.json` manifest with source URLs, schema migrations, and a `fetch-and-seed` script. The data lives in the database, not git.

**Data volume estimate at national scale:**
- ~6,000 US hospitals
- ~250,000 rates rows per hospital (50 payer contracts x 5,000 procedures)
- ~1.5 billion rows total; plan for 50-200GB of storage depending on indexing

---

## Postgres Schema

### `hospitals`

Core registry of hospital metadata and MRF source locations.

```sql
CREATE TABLE hospitals (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  ein             TEXT UNIQUE,           -- CMS identifier
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  lat             NUMERIC(9,6),          -- for geo radius queries
  lon             NUMERIC(9,6),
  source_url      TEXT,                  -- MRF file location
  last_fetched_at TIMESTAMPTZ,
  last_parsed_at  TIMESTAMPTZ
);
```

### `procedures`

Canonical procedure codes. Each code/type pair stored once -- not repeated per rate row.

```sql
CREATE TABLE procedures (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  code_type     TEXT NOT NULL,           -- 'CPT', 'HCPCS', 'DRG', 'RC', 'CDM'
  description   TEXT,                   -- raw description from CMS file
  display_name  TEXT,                   -- human-friendly name (Phase 2 mapping)
  UNIQUE (code, code_type)
);
```

### `rates`

The primary table. One row per hospital + procedure + payer + rate type combination.

```sql
CREATE TABLE rates (
  id            BIGSERIAL PRIMARY KEY,
  hospital_id   INT NOT NULL REFERENCES hospitals(id),
  procedure_id  INT NOT NULL REFERENCES procedures(id),
  payer_name    TEXT,                   -- null = cash/self-pay
  plan_name     TEXT,
  rate_type     TEXT NOT NULL,          -- 'gross', 'cash', 'negotiated', 'min', 'max'
  amount        NUMERIC(12,2),
  UNIQUE (hospital_id, procedure_id, payer_name, plan_name, rate_type)
);
```

### Indexes

```sql
CREATE INDEX idx_rates_hospital     ON rates(hospital_id);
CREATE INDEX idx_rates_procedure    ON rates(procedure_id);
CREATE INDEX idx_procedures_code    ON procedures(code);
CREATE INDEX idx_hospitals_zip      ON hospitals(zip);
CREATE INDEX idx_hospitals_state    ON hospitals(state);
```

---

## Design Decisions

**`payer_name` is plain text, not a foreign key.** Payer names vary widely across hospital files ("BCBS", "Blue Cross Blue Shield", "BCBS-TX"). Normalizing payer names is a Phase 2 problem. Start loose, clean up later.

**`rate_type` as a single column.** Covers all five CMS-required rate categories (`gross`, `cash`, `negotiated`, `min`, `max`) in one column rather than separate columns. Keeps the schema stable across CMS schema variations between hospitals.

**`display_name` on `procedures` is nullable.** This is the Phase 2 hook for mapping CPT codes to plain-language names (e.g., "99213" → "Office Visit, Established Patient"). Leave null during Phase 1.

**Storage efficiency.** Storing procedure descriptions once in `procedures` rather than repeating them in every rate row cuts the rates table size by ~40-60% compared to storing raw CSV rows.

---

## Primary Query Pattern

"Show me prices for a given procedure near a given location."

```sql
SELECT
  h.name,
  h.city,
  r.payer_name,
  r.plan_name,
  r.rate_type,
  r.amount
FROM rates r
JOIN hospitals h ON h.id = r.hospital_id
JOIN procedures p ON p.id = r.procedure_id
WHERE p.code = '73721'              -- CPT code (e.g., Knee MRI)
  AND h.state = 'TX'
  AND h.zip IN (/* zipcode radius list */)
ORDER BY r.amount ASC;
```

For geo-radius filtering, populate `lat`/`lon` on `hospitals` and use a Haversine distance filter or PostGIS `ST_DWithin` when ready to invest in that dependency.

---

## Parse/Normalize Pipeline

The pipeline maps raw CMS CSV columns to this schema on ingest.

### CMS CSV Column Mapping

| CMS field | Target table | Target column | Notes |
|---|---|---|---|
| `description` | `procedures` | `description` | Raw; use for `display_name` in Phase 2 |
| `code` | `procedures` | `code` | Strip whitespace |
| `code_type` | `procedures` | `code_type` | Normalize to uppercase |
| `standard_charge_gross` | `rates` | `amount` | `rate_type = 'gross'` |
| `standard_charge_discounted_cash` | `rates` | `amount` | `rate_type = 'cash'` |
| `standard_charge_negotiated_dollar` | `rates` | `amount` | `rate_type = 'negotiated'` |
| `standard_charge_min` | `rates` | `amount` | `rate_type = 'min'` |
| `standard_charge_max` | `rates` | `amount` | `rate_type = 'max'` |
| `payer_name` | `rates` | `payer_name` | Raw; normalize in Phase 2 |
| `plan_name` | `rates` | `plan_name` | Raw |

### Pseudocode

```javascript
async function ingestHospitalFile(hospitalId, csvPath) {

  // Stream the CSV -- do not load entire file into memory
  const stream = fs.createReadStream(csvPath).pipe(csvParse({ columns: true }));

  for await (const row of stream) {

    // 1. Upsert procedure (deduplicates across hospitals)
    const procedureId = await upsertProcedure({
      code:      row.code?.trim().toUpperCase(),
      code_type: row.code_type?.trim().toUpperCase(),
      description: row.description?.trim(),
    });

    // 2. Insert one rate row per rate type present in this CSV row
    const rateTypes = [
      { field: 'standard_charge_gross',             type: 'gross' },
      { field: 'standard_charge_discounted_cash',   type: 'cash' },
      { field: 'standard_charge_negotiated_dollar', type: 'negotiated' },
      { field: 'standard_charge_min',               type: 'min' },
      { field: 'standard_charge_max',               type: 'max' },
    ];

    for (const { field, type } of rateTypes) {
      const amount = parseFloat(row[field]);
      if (isNaN(amount)) continue;          // skip missing/null values

      await upsertRate({
        hospital_id:  hospitalId,
        procedure_id: procedureId,
        payer_name:   row.payer_name?.trim() || null,
        plan_name:    row.plan_name?.trim()  || null,
        rate_type:    type,
        amount,
      });
    }
  }
}
```

### Key implementation notes

- **Stream, don't load.** These files can be 500MB+. Use `csv-parse` in streaming mode (already in your stack).
- **Upsert, don't insert.** Use `INSERT ... ON CONFLICT DO NOTHING` (or `DO UPDATE`) for both `procedures` and `rates`. Re-running ingest after a file update should be safe.
- **Batch writes.** Accumulate 500-1000 rows in memory and write in a single transaction. Row-by-row inserts on a 5M-row file will be extremely slow.
- **Schema variations.** Column names differ across hospitals. Build a column mapper that accepts aliases (e.g., `charge_amount`, `standard_charge`, `rate`) and normalizes them before the field lookup above.
- **Null handling.** Many fields will be empty strings, not SQL nulls. Coerce `""` and `"N/A"` to `null` before inserting.

---

## SQLite → Postgres Migration Path

Write Phase 1 queries as if they'll run on Postgres (avoid SQLite-specific syntax). The main differences to watch:

| SQLite | Postgres equivalent |
|---|---|
| `INTEGER PRIMARY KEY` | `SERIAL PRIMARY KEY` |
| No `RETURNING` clause | `INSERT ... RETURNING id` |
| `PRAGMA` for config | Connection string params |
| Single file on disk | Connection pool required |

Use `better-sqlite3` for local dev, `pg` (node-postgres) for production. Abstract the DB layer behind a thin `db.js` module so the swap is a config change, not a rewrite.

---

## Future Considerations

**Full-text search on procedure names.** Add a `tsvector` column to `procedures` and a GIN index when fuzzy procedure name search becomes a priority. Postgres handles this natively without Fuse.js.

**DuckDB + Parquet at national scale.** If Postgres hosting costs become prohibitive at 500+ hospitals, DuckDB running analytical queries against Parquet files on S3 is worth evaluating. Well-suited to the read-heavy, query-by-code-and-location access pattern.

**Annual refresh pipeline.** CMS files update roughly annually. Build `fetch-and-seed` to diff against `last_fetched_at` on the `hospitals` table and only re-ingest files that have changed (use HTTP `ETag` or `Last-Modified` headers from the source URL where available).
