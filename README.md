# Hospital Price Transparency Tool

A web app that transforms CMS-mandated hospital pricing files into a searchable, consumer-friendly interface.

## The Problem

Since January 2021, [CMS requires hospitals](https://www.cms.gov/hospital-price-transparency) to publish their prices in machine-readable formats. The files exist, but they're massive CSVs or JSON blobs designed for data systems, not people. A typical file runs tens of thousands of rows with cryptic billing codes and payer-specific rates.

This tool bridges the gap between regulatory compliance and consumer utility.

## What It Does

- Parses hospital machine-readable pricing files (CSV format, following CMS standard charge schema)
- Lets users search by procedure name, CPT/HCPCS code, or plain-language description
- Displays prices across payers (insurance plans) in a clear comparison view
- Highlights cash/self-pay prices alongside negotiated rates
- Starts with Ascension Seton Medical Center Austin as the proof-of-concept hospital

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  React Frontend                  │
│  Search bar → Results table → Price comparison   │
└────────────────────┬────────────────────────────┘
                     │ REST API
┌────────────────────▼────────────────────────────┐
│               Node.js Backend                    │
│  Express API → Search/filter → Paginated results │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│              Data Pipeline                       │
│  Fetch CSV → Parse → Normalize → SQLite/JSON     │
└─────────────────────────────────────────────────┘
```

## Project Structure

```
hospital-price-transparency/
├── README.md
├── package.json
├── scripts/
│   ├── fetch-data.js          # Download MRF files from hospital sites
│   ├── parse-csv.js           # Parse and normalize raw CSV data
│   └── seed-db.js             # Load parsed data into SQLite
├── src/
│   ├── server.js              # Express API server
│   ├── components/
│   │   ├── App.jsx            # Main app shell
│   │   ├── SearchBar.jsx      # Procedure/code search input
│   │   ├── ResultsTable.jsx   # Price comparison table
│   │   └── PriceCard.jsx      # Individual procedure price display
│   ├── utils/
│   │   ├── normalize.js       # Standardize procedure names, codes
│   │   ├── search.js          # Search/filter logic
│   │   └── format.js          # Currency, percentage formatting
│   └── data/
│       └── hospitals.json     # Hospital metadata (name, URL, file location)
├── public/
│   └── index.html
├── .gitignore
├── .env.example
└── LICENSE
```

## Roadmap

### Phase 1: Single Hospital Proof of Concept
- [x] Project skeleton and architecture
- [ ] Download and parse Ascension Seton Medical Center Austin CSV
- [ ] Build search API with basic text matching
- [ ] Minimal React UI: search bar + results table
- [ ] Deploy static demo

### Phase 2: Make It Useful
- [ ] Add 2-3 more Austin-area hospitals for comparison
- [ ] Plain-language procedure name mapping (CPT code → "Knee MRI")
- [ ] Filter by payer/insurance plan
- [ ] Price range visualization
- [ ] "What is this?" tooltips for billing terminology

### Phase 3: Scale and Polish
- [ ] Generalized CSV parser handling schema variations across hospitals
- [ ] Automated data refresh pipeline
- [ ] Full-text search with fuzzy matching
- [ ] Cost estimator (procedure price + facility fee + common add-ons)
- [ ] Responsive mobile design

## Data Sources

| Hospital | Location | File Format | URL |
|----------|----------|-------------|-----|
| Ascension Seton Medical Center Austin | Austin, TX | CSV | [Link](https://healthcare.ascension.org/-/media/project/ascension/healthcare/price-transparency-files/tx-csv/741109643-1164526786_ascension-seton_standardcharges.csv) |

## CMS Standard Charge Schema

The CMS rule (45 C.F.R. § 180.50) requires hospitals to publish:

- **Gross charges**: The hospital's list price before any discounts
- **Discounted cash price**: What self-pay patients are charged
- **Payer-specific negotiated rates**: What each insurance plan actually pays
- **De-identified min/max**: The lowest and highest negotiated rate across all payers

Each row typically includes a billing code (CPT, HCPCS, DRG, or internal), a description, and rate columns per payer/plan combination.

## Tech Stack

- **Frontend**: React, Tailwind CSS
- **Backend**: Node.js, Express
- **Data**: SQLite (via better-sqlite3) for local development
- **Parsing**: csv-parse for streaming CSV processing
- **Search**: Fuse.js for fuzzy matching

## Getting Started

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/hospital-price-transparency.git
cd hospital-price-transparency

# Install dependencies
npm install

# Download and parse hospital data
npm run fetch-data
npm run parse-data

# Start the dev server
npm run dev
```

## Why This Matters

Price transparency in healthcare is a solvable problem on the data side. The regulatory framework exists. The data is published. What's missing is the translation layer that makes it useful for the people who need it most: patients making decisions about where to get care.

## License

MIT
