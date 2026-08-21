# Hospital Price Transparency Tool

A web app that transforms CMS-mandated hospital pricing files into a searchable, consumer-friendly interface — with a Medicare baseline so patients can see not just what a hospital charges, but how that compares to what Medicare pays for the same procedure.

**Live at [texashealthprices.org](https://texashealthprices.org)** (also reachable at [hospital-price-transparency.fly.dev](https://hospital-price-transparency.fly.dev)).

## The Problem

Since January 2021, [CMS requires hospitals](https://www.cms.gov/hospital-price-transparency) to publish their prices in machine-readable formats. The files exist, but they're massive CSVs or JSON blobs designed for data systems, not people. A typical file runs tens of thousands of rows with cryptic billing codes and payer-specific rates.

This tool bridges the gap between regulatory compliance and consumer utility.

## What It Does

- Autocomplete search by plain-language procedure name (not just raw CPT/HCPCS codes), backed by SQLite full-text search with BM25 ranking
- Compares prices for the same procedure across 4 Austin-area hospitals side by side
- Insurance/payer picker, grouped by category (BCBS, Aetna, United, etc.)
- Highlights the cash/self-pay price (with its range) alongside negotiated rates
- Care setting toggle — All / Outpatient / Inpatient
- **Medicare comparison banner**: estimates the total Medicare payment for the same procedure — PFS physician fee + OPPS hospital facility fee for outpatient, or the IPPS DRG-based bundled payment (with per-hospital IME/DSH adjustments) for inpatient — and shows a "% vs Medicare" badge on each insurance rate
- Handles all OPPS status indicators (payable, packaged, alternate fee schedule, inpatient-only) with plain-language explanations rather than raw codes

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  React Frontend                  │
│  Search bar → Results table → Price comparison   │
│  + Medicare banner, insurance picker, setting     │
│    toggle                                         │
└────────────────────┬────────────────────────────┘
                     │ REST API
┌────────────────────▼────────────────────────────┐
│               Node.js Backend                    │
│  Express API → Search/filter → Medicare lookup    │
│  (PFS + OPPS + DRG) → Payer-grouped results       │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│              Data Pipeline                       │
│  Fetch hospital MRFs + CMS PFS/OPPS/DRG files →   │
│  Parse → Normalize → Friendly names → SQLite      │
└─────────────────────────────────────────────────┘
```

## Project Structure

```
hospital-price-transparency/
├── README.md
├── package.json
├── fly.toml                        # Fly.io deployment config
├── scripts/
│   ├── fetch-data.js               # Download hospital MRF files
│   ├── parse-csv.js                # Parse/normalize CSV-format MRFs
│   ├── parse-json.js               # Parse/normalize JSON-format MRFs
│   ├── seed-db.js                  # Load parsed data into SQLite
│   ├── build-friendly-names.js     # CPT/HCPCS code → plain-language name mapping
│   ├── fetch-medicare.js           # CMS Physician Fee Schedule (facility/non-facility rates)
│   ├── fetch-opps.js               # CMS OPPS Addendum B (hospital outpatient facility fees)
│   └── fetch-drg.js                # CMS IPPS DRG payments (inpatient, per-hospital)
├── src/
│   ├── server.js                   # Express API server
│   ├── components/
│   │   ├── App.jsx
│   │   ├── AutocompleteSearch.jsx
│   │   ├── SearchBar.jsx
│   │   ├── ResultsTable.jsx
│   │   ├── HospitalCard.jsx
│   │   ├── PriceCard.jsx
│   │   ├── InsurancePicker.jsx
│   │   ├── SettingToggle.jsx
│   │   ├── MedicareBanner.jsx
│   │   └── Tooltip.jsx
│   ├── utils/
│   │   └── format.js
│   └── data/
├── public/
│   └── index.html
├── .gitignore
└── LICENSE
```

## Data Sources

| Hospital | Location |
|----------|----------|
| Ascension Seton Medical Center Austin | Austin, TX |
| Dell Seton Medical Center at UT Austin | Austin, TX |
| Baylor Scott & White Medical Center Austin | Austin, TX |
| St. David's Medical Center Austin | Austin, TX |

Plus CMS reference data: Physician Fee Schedule (RVU file), OPPS Addendum B (quarterly), and IPPS DRG payment tables — used to compute the Medicare comparison baseline.

## CMS Standard Charge Schema

The CMS rule (45 C.F.R. § 180.50) requires hospitals to publish:

- **Gross charges**: The hospital's list price before any discounts
- **Discounted cash price**: What self-pay patients are charged
- **Payer-specific negotiated rates**: What each insurance plan actually pays
- **De-identified min/max**: The lowest and highest negotiated rate across all payers

Each row typically includes a billing code (CPT, HCPCS, DRG, or internal), a description, and rate columns per payer/plan combination.

## Tech Stack

- **Frontend**: React, Vite, Tailwind CSS
- **Backend**: Node.js, Express
- **Data**: SQLite (via better-sqlite3)
- **Parsing**: csv-parse (streaming) / stream-json for the two MRF file formats hospitals publish in
- **Search**: SQLite FTS5 with BM25 ranking over plain-language procedure names — no external search library
- **Deployment**: Fly.io (region: dfw), SQLite on a persistent volume

## Getting Started

```bash
git clone https://github.com/smorrel9/hospital-price-transparency.git
cd hospital-price-transparency
npm install

# Full data pipeline: hospital MRFs + CMS Medicare reference data (~30 min,
# downloads ~1GB and parses 30M+ rows)
npm run setup

npm run dev
```

## Roadmap

Shipped: 4-hospital comparison, friendly-name search, insurance picker, care setting toggle, full Medicare baseline (PFS + OPPS + DRG) with % vs Medicare badges, live deployment.

Open ideas:
- Generalized CSV/JSON parser hardening as more hospitals are added
- Automated annual data refresh pipeline
- Cost estimator (procedure price + facility fee + common add-ons)
- A companion site-of-service tool (office vs. ASC vs. hospital outpatient) is in progress as a separate project: [site-of-service-comparison](https://github.com/smorrel9/site-of-service-comparison)

## Why This Matters

Price transparency in healthcare is a solvable problem on the data side. The regulatory framework exists. The data is published. What's missing is the translation layer that makes it useful for the people who need it most: patients making decisions about where to get care.

## License

MIT
