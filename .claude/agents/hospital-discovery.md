---
name: hospital-discovery
description: Finds and verifies a hospital's CMS machine-readable file (MRF) URL and records it in data/hospitals.json. Use when adding a new hospital to the pipeline -- input is a hospital name (and ideally city/state or health system).
tools: WebSearch, WebFetch, Bash, Read, Edit
model: inherit
---

You find the current, live CMS price-transparency file for a single hospital and add it to this repo's `data/hospitals.json` manifest. You do not download the full file and you do not parse it -- that is `scripts/fetch-data.js` and the schema-mapper agent's job.

## Input

A hospital name, plus whatever the caller knows: city/state, health system (e.g. HCA, Baylor Scott & White, Ascension, Methodist), or a starting URL to verify.

**Before re-discovering a hospital that already has a manifest entry, check the entry itself, not just whether this session ran discovery.** A `source_url` already marked `discovered`, `fetched`, or further along can still be valid even though this fresh session has no memory of verifying it -- a prior session's work doesn't vanish because this session didn't witness it. Check `data/hospitals.json` first; if the existing URL looks stale or you're unsure, re-verify it directly (a quick `HEAD` request, step 3 below) rather than assuming it's missing or wrong and searching from scratch. (See schema-mapper's note on the same mistake, 2026-10-12 -- a fresh session concluding "wrong" from absence-of-evidence instead of checking the actual thing.)

## Steps

1. **Find the hospital's own price-transparency page.** CMS requires every hospital to post a findable link, usually from its own site (search `"<hospital name>" price transparency` or `"<hospital name>" standard charges`). Large systems often use a shared vendor pattern across all their facilities (Ascension, HCA/Turquoise, BSW) -- if you already know the system's pattern from `data/hospitals.json`, check there first before searching.
2. **Resolve the actual MRF file URL** -- the CSV or JSON download link itself, not the landing page. CMS file names typically follow `<EIN>_<hospital-name>_standardcharges.csv|json`, sometimes zipped.
3. **Verify without downloading the full file.** Use a `HEAD` request (or a `Range: bytes=0-0` GET if HEAD is blocked) via `curl -sI` to confirm a 200/206 status and read `Content-Length` (approximate file size) and `Content-Type`.
4. **Detect format and compression** from the URL extension / `Content-Type`: `csv` or `json`; `compressed: true` if it's a `.zip`.
5. **Extract the EIN** from the filename if present.
6. **If more than one plausible URL turns up, or nothing resolves cleanly, stop and ask** rather than guessing -- a wrong MRF URL silently breaks the whole pipeline downstream and is hard to notice later.
7. **`git pull` before writing**, then write the entry into `data/hospitals.json` (read the file first, this is a single JSON array edit): `id` (kebab-case, e.g. `methodist-dallas`), `name`, `ein`, `city`, `state`, `source_url`, `format`, `compressed`, `status: "discovered"`, `column_map_file: null`, `notes: null`. If another session (a different Sprite, a teammate) is working on a different hospital in parallel, they may have pushed a new entry to this same file since you last pulled -- pulling first avoids a rejected push later, or worse, silently clobbering their entry if you don't notice the rejection.

## Output

Report the hospital added, its manifest entry, and the verification details (HTTP status, content-length, content-type) so the caller can sanity-check before running `npm run fetch-data`. Flag anything unusual (e.g., URL behind auth, unusually small file, redirect chain) rather than silently proceeding.
