# Adding a hospital

This is the on-demand workflow for growing coverage past the original 4 Austin hospitals. It's not scheduled or automated end-to-end on purpose -- each new hospital's file can have its own quirks (see `database-architecture.md` for the BSW mislabeling precedent), so a human approves the schema mapping and QA report before anything reaches the live DB.

Run this from a Claude Code session with access to this repo -- either locally, or inside a Fly.io Sprite (see `docs/sprites-setup.md`) if you'd rather not pull multi-GB files onto your laptop.

## Steps

1. **Add the hospital.** Tell Claude Code the hospital name (and city/state or health system if you know it). It should invoke the `hospital-discovery` subagent, which finds the CMS MRF URL, verifies it resolves, and writes an entry to `data/hospitals.json` with `status: "discovered"`.

2. **Fetch the raw file.**
   ```bash
   npm run fetch-data
   ```
   Downloads every hospital in the manifest that has a `source_url` and doesn't already have a raw file on disk -- safe to re-run as you add hospitals one at a time, since it skips anything already fetched. Pass `--force` to re-download everything (e.g. after a CMS annual refresh). Lands in `data/raw/<hospital-id>.csv` or `.json`.

3. **Map the schema.** Ask Claude Code to run the `schema-mapper` subagent against the new file. It proposes a column mapping and flags quirks (mislabeled code types, unmapped columns), writing `data/column-maps/<hospital-id>.json` if an override is needed. **Review this before continuing** -- it's a diff against the default `COLUMN_MAP` in `scripts/parse-csv.js`, not a full replacement, so a short review is usually enough.

   Also check the file's **layout**: CMS v3.0.0 allows both "tall" (generic `payer_name`/`plan_name` columns, one row per procedure+payer+plan -- what the Austin hospitals use) and "wide" (payer+plan baked into column names like `standard_charge|Aetna|HMO_Inpatient|negotiated_dollar`, one row per procedure -- what MD Anderson uses, likely at any hospital with many payer contracts). A header row with no literal `payer_name` column is wide format and needs step 4's second script.

4. **Parse.**
   ```bash
   npm run parse-data        # CSV, tall layout
   npm run parse-data-wide   # CSV, wide layout (payer/plan in column names)
   npm run parse-json        # JSON-format hospitals
   ```
   Streams the raw file to `data/parsed/<hospital-id>.ndjson`, applying the column map and any code-type promotion rules. Running the wrong script against a file just logs a "detected X layout, skipping" message and leaves any existing output untouched -- it won't clobber anything.

5. **QA.** Ask Claude Code to run the `data-qa` subagent against the new NDJSON. It checks row survival rate, code-type distribution, price sanity, null rates, cross-hospital code overlap, and payer-name hygiene, then writes `data/qa-reports/<hospital-id>.md` with a pass/flag verdict and a recommendation. **Read the recommendation before seeding** -- this is the check that would have caught the BSW mislabeling bug before it shipped.

6. **Seed.**
   ```bash
   npm run seed-db
   ```
   Rebuilds `data/prices.db` from everything in `data/parsed/`. (Full rebuild, not incremental -- fine at pilot scale; revisit if this gets slow at 20+ hospitals.)

7. **Update the manifest status** to `seeded` for the hospital in `data/hospitals.json`, and rebuild friendly names / FTS if needed:
   ```bash
   npm run build-names
   ```

8. **Deploy.** Same as always -- `fly deploy` (or whatever your current Fly.io deploy step is) once `data/prices.db` looks right locally.

## Manifest status values

`discovered` -> `mapped` -> `parsed` -> `qa_pending` -> `seeded` (or `flagged` if QA recommends holding).

## Column-map override format (`data/column-maps/<hospital-id>.json`)

```json
{
  "columnMap": { "<raw CSV header>": "<internal field name>" },
  "promotions": [{ "from": "HCPCS", "to": "CPT", "pattern": "^\\d{5}$" }],
  "notes": "what the schema-mapper agent found and why"
}
```

Only include what differs from the default `COLUMN_MAP` -- this is a diff, not a full schema.
