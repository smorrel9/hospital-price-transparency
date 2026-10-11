# QA report: houston-methodist

Date: 2026-10-11
Source: `74110155_the-methodist-hospital_standardcharges.json`, CMS v3.0.0 JSON, same nested `standard_charge_information`/`code_information`/`standard_charges`/`payers_information` shape St. David's uses -- parsed by `scripts/parse-json.js`, no new parser needed.

## First pass: FAILED

Initial QA caught a real bug before this reached the DB in a trustworthy state:

| Check | Result | Verdict |
|---|---|---|
| code_type distribution | HCPCS: 183,178 / MS-DRG: 69,899 -- **zero CPT codes** | **FAIL** |
| Cross-hospital CPT overlap | 0 of 0 CPT codes (undefined -- hospital had none) | **FAIL** |

Zero CPT codes across 253k rows at a general acute-care hospital is exactly the anomaly this check exists to catch. Investigation found 75.6% of the "HCPCS"-labeled codes (138,437 of 183,178) were 5-digit all-numeric codes like `96360`/`96361` (IV hydration/infusion) -- genuine CPT codes mislabeled as HCPCS, the same pattern BSW's CSV has. Root cause: `scripts/parse-json.js` never had the HCPCS->CPT promotion rule that `scripts/parse-csv.js` already applies by default -- it was added to the CSV parser specifically for BSW and never ported to the JSON parser, so every JSON-format hospital was silently exposed to this risk. St. David's happened to not trigger it (0% mislabeled there), which is why the gap went unnoticed.

**Fix:** `parse-json.js` now imports `loadOverride` from `parse-csv.js` and applies the same promotion rules (default + any per-hospital override) after code extraction, instead of duplicating the rule. Also added an `import.meta.url` execution guard to `main()`, consistent with the other parse scripts.

## Second pass (after fix): PASSED

| Check | Result | Verdict |
|---|---|---|
| Row survival / seeded total | 253,077 rows (unchanged from first pass -- the fix only relabels codes, doesn't drop/add rows) | PASS |
| code_type distribution | CPT: 138,437 / MS-DRG: 69,899 / HCPCS: 44,741 -- healthy three-way split | PASS |
| Null negotiated-rate rate | 48,591 / 253,077 = 19.2% | PASS |
| Price sanity (negative/zero negotiated_rate) | 0 rows | PASS |
| **Cross-hospital CPT overlap** | 9,955 of 10,014 distinct CPT codes (99.4%) also appear at the other 5 hospitals | PASS -- higher overlap than MD Anderson's 96%, strong confirmation the fix is correct |
| Payer name hygiene | Top 10 all clean (Cigna, Aetna, Molina Healthcare, Community Health Choice, Bcbs, Unitedhealthcare, Optum Health, Procare Advantage, Uae, Humana) | PASS |

## Recommendation

**Proceed.** Clean on every check after the fix. This also means St. David's and any future JSON-format hospital now benefit from the same promotion-rule protection the CSV parsers already had -- worth re-checking St. David's wasn't silently affected too (it wasn't: 0% of its HCPCS codes are 5-digit numeric, confirmed before the fix was written).
