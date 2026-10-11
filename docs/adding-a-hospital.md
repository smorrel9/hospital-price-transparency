# Adding a hospital

This is the on-demand workflow for growing coverage past the original 4 Austin hospitals. It's not scheduled or automated end-to-end on purpose -- each new hospital's file can have its own quirks (see `database-architecture.md` for the BSW mislabeling precedent), so a human approves the schema mapping and QA report before anything reaches the live DB.

Run this from a Claude Code session with access to this repo -- either locally, or inside a Fly.io Sprite (see `docs/sprites-setup.md`) if you'd rather not pull multi-GB files onto your laptop.

## Working in parallel (multiple Sprites / teammates)

`data/hospitals.json` is the one file every session touches, no matter which hospital it's working on -- it's the collision point if more than one Sprite or teammate is adding hospitals at the same time. `git pull` before any step that writes to it (discovery writing a new entry, updating status to `seeded`, etc.) -- a stale push just gets rejected by git, so this isn't a data-loss risk, but pulling first avoids the rejection (and the pause to sort it out) entirely. This is already built into the `hospital-discovery` subagent's own steps; the manual status-update steps below need the same habit.

## Steps

1. **Add the hospital.** Tell Claude Code the hospital name (and city/state or health system if you know it). It should invoke the `hospital-discovery` subagent, which finds the CMS MRF URL, verifies it resolves, pulls, and writes an entry to `data/hospitals.json` with `status: "discovered"`.

2. **Fetch the raw file.**
   ```bash
   npm run fetch-data
   ```
   Downloads every hospital in the manifest that has a `source_url` and doesn't already have a raw file on disk -- safe to re-run as you add hospitals one at a time, since it skips anything already fetched. Pass `--force` to re-download everything (e.g. after a CMS annual refresh). Lands in `data/raw/<hospital-id>.csv` or `.json`.

3. **Pre-flight check.**
   ```bash
   npm run preflight -- <hospital-id>
   ```
   Seconds, not minutes -- samples a few thousand rows/items from the raw file (not a full parse) and checks the two things that have actually caused rework in this pipeline:
   - **Layout** (CSV only): "tall" (generic `payer_name`/`plan_name` columns, one row per procedure+payer+plan -- what the Austin hospitals use) vs "wide" (payer+plan baked into column names like `standard_charge|Aetna|HMO_Inpatient|negotiated_dollar`, one row per procedure -- what MD Anderson uses). Wide needs `npm run parse-data-wide` in step 5, not `parse-data`.
   - **Code-type mislabeling**: for each labeled code type, whether its sampled codes actually match that type's expected shape (5-digit-numeric codes labeled "HCPCS" should be CPT -- the BSW and Houston Methodist pattern). It specifically keeps scanning past category-heavy sections (e.g. a file that lists thousands of pharmacy/NDC items before any procedure code) rather than just sampling the first N rows, since that's exactly how the Houston Methodist mislabeling went undetected on a naive sample.

   A clean pre-flight run doesn't guarantee the full parse will be perfect, but both real bugs hit so far would have surfaced here in seconds instead of after a full parse+seed cycle. If it flags something, that's the signal to write a `data/column-maps/<hospital-id>.json` override (see format below) before continuing.

4. **Map the schema, if pre-flight flagged anything.** Ask Claude Code to run the `schema-mapper` subagent against the new file, informed by the pre-flight findings. It proposes a column mapping and promotion rule, writing `data/column-maps/<hospital-id>.json`. **Review this before continuing** -- it's a diff against the default `COLUMN_MAP` in `scripts/parse-csv.js`, not a full replacement, so a short review is usually enough. If pre-flight came back clean, this step can usually be skipped.

5. **Parse.**
   ```bash
   npm run parse-data        # CSV, tall layout
   npm run parse-data-wide   # CSV, wide layout (payer/plan in column names)
   npm run parse-json        # JSON-format hospitals
   ```
   Streams the raw file to `data/parsed/<hospital-id>.ndjson`, applying the column map and any code-type promotion rules. Running the wrong script against a file just logs a "detected X layout, skipping" message and leaves any existing output untouched -- it won't clobber anything.

6. **QA.** Ask Claude Code to run the `data-qa` subagent against the new NDJSON. It checks row survival rate, code-type distribution, price sanity, null rates, cross-hospital code overlap, and payer-name hygiene, then writes `data/qa-reports/<hospital-id>.md` with a pass/flag verdict and a recommendation. **Read the recommendation before seeding** -- this is the full-data check behind pre-flight's quick sample, and it's still worth running even after a clean pre-flight.

7. **Seed.**
   ```bash
   npm run seed-db
   ```
   Rebuilds `data/prices.db` from everything in `data/parsed/`. (Full rebuild, not incremental -- fine at pilot scale; revisit if this gets slow at 20+ hospitals.)

8. **`git pull`, then update the manifest status** to `seeded` for the hospital in `data/hospitals.json` (see "Working in parallel" above), and rebuild friendly names / FTS if needed:
   ```bash
   npm run build-names
   ```

9. **Deploy.** Same as always -- `fly deploy` (or whatever your current Fly.io deploy step is) once `data/prices.db` looks right locally.

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
