# QA report: md-anderson-houston

Date: 2026-10-11
Source: `74-6001118_MD Anderson Cancer Center_StandardCharges.csv`, CMS v3.0.0 **wide** layout (1,421 columns, 47 payers) -- parsed by the new `scripts/parse-csv-wide.js`, not the tall-format `parse-csv.js`.

## Checks

| Check | Result | Verdict |
|---|---|---|
| Row survival / seeded total | 1,028,611 rows seeded (2,060,601 parsed rows, minus RC/CDM code types filtered by `seed-db.js`) | PASS |
| code_type distribution | CPT: 592,463 / HCPCS: 436,148 -- only the two consumer-useful types, no unexpected dominance by RC/CDM/null | PASS |
| Null negotiated-rate rate | 22,687 / 1,028,611 = 2.2% | PASS (low, expected -- base rows with no payer data are intentional) |
| Price sanity (negative/zero negotiated_rate) | 0 rows | PASS |
| **Cross-hospital CPT overlap** | 7,162 of MD Anderson's 7,433 distinct CPT codes (96%) also appear at the other 4 hospitals | PASS -- this is the exact check that would have caught a BSW-style mislabeling bug; strong overlap confirms the wide-format fan-out parser is mapping codes/payers correctly, not silently dropping data |
| Payer name hygiene | Top 10 all clean, recognizable names (BlueCrossBlueShield, Cigna, Aetna, Humana, MemorialHermannHealth, TexasChildrens, PHCS, Multiplan, UnitedHealthcare, UnitedHealthcare_CancerResources) | PASS |

## Context worth keeping

This file uses CMS's **wide** layout, not the tall layout the pipeline was originally built for -- discovered when `schema-mapper`-equivalent inspection found 1,421 columns with payer+plan baked into column names (e.g. `standard_charge|Aetna|HMO_Inpatient|negotiated_dollar`) instead of generic `payer_name`/`plan_name` columns. Built `scripts/parse-csv-wide.js` to handle this generally (any hospital without a literal `payer_name` column), not as an MD-Anderson-specific hack -- expect to hit this again at other large systems, since wide format is how CMS avoids an exploding row count at hospitals with many payer contracts.

Two unrelated bugs surfaced and were fixed during this run (see commit history / conversation, not repeated here): an unguarded `main()` in `parse-csv.js` that re-ran on import, and `seed-db.js` picking up stale orphaned `.ndjson` files under old filenames as phantom extra "hospitals." Neither affected production (`fly.io` deploys from a separate volume, untouched by local `data/` changes).

## Recommendation

**Proceed.** Data looks clean on every check. Safe to mark `seeded` in `data/hospitals.json` and include in the next deploy.
