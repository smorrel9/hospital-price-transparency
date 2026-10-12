# Hospital queue

Backlog of candidate hospitals for the pilot expansion, so there's always a next pick ready without re-researching from scratch. Not verified manifest entries -- that's what `hospital-discovery` does when a hospital actually gets picked up. Bed counts/rankings via web search 2026-10-12, worth a sanity-check if this list is used much later (hospital systems merge/rename).

## Done / in progress

| Hospital | City | Status |
|---|---|---|
| Ascension Seton Medical Center Austin | Austin | Seeded |
| Dell Seton Medical Center at UT Austin | Austin | Seeded |
| Baylor Scott & White Medical Center Austin | Austin | Seeded |
| St. David's Medical Center Austin | Austin | Seeded (source URL expired, see `known-issues.md`) |
| The Methodist Hospital (Houston Methodist flagship) | Houston | Seeded |
| MD Anderson Cancer Center | Houston | Seeded |
| UT Southwestern (William P. Clements Jr. University Hospital) | Dallas | In pipeline |

## Houston queue

Ranked roughly by size/prominence, largest first:

1. **Memorial Hermann-Texas Medical Center** -- 1,137 beds, the single largest hospital in Houston, flagship of the Memorial Hermann system.
2. **Texas Children's Hospital** -- 973 beds, pediatric specialty. Worth prioritizing over another general hospital for procedure-mix diversity (very different from everything currently in the pipeline).
3. **Baylor St. Luke's Medical Center** -- 881 beds, CommonSpirit/CHI St. Luke's Health. Note: this is a *different* Baylor entity from Baylor Scott & White (already in the pipeline via BSW Austin) -- don't assume it's already covered.
4. **HCA Houston Healthcare** -- a market-leading system in Houston with several facilities; would need a specific flagship picked (e.g. HCA Houston Healthcare Medical Center) rather than treating "HCA Houston Healthcare" as one hospital.
5. **Ben Taub Hospital** (Harris Health System) -- Houston's public/safety-net hospital. Lower revenue profile than the others here, but a genuinely different payer mix (more charity care, Medicaid) worth having in the dataset for comparison purposes, not just size.

Houston Methodist's other campuses (Baytown, Clear Lake, Cypress, Sugar Land, The Woodlands, West Houston, Willowbrook, Continuing Care) are a lower-priority option too -- same health system already represented by the flagship, so adds less variety than a new system would, but each is a quick add once `houston-methodist` is working (same file format/shape, known-good CMS JSON per `data/hospitals.json`'s notes on that entry).

## Dallas queue

1. **Baylor University Medical Center at Dallas** -- 914 beds, Baylor Scott & White's Dallas flagship. Distinct facility/EIN from BSW Austin already in the pipeline.
2. **Medical City Dallas** -- 899 beds, HCA-affiliated.
3. **Parkland Memorial Hospital** -- 882 beds, Dallas County's public/safety-net hospital. Same rationale as Ben Taub for Houston -- worth having a safety-net system represented, not just size-ranked picks.
4. **Methodist Dallas Medical Center** (Methodist Health System) -- **naming trap**: this is a completely different organization from Houston Methodist (already in the pipeline as `houston-methodist`). Don't assume "Methodist" is already covered when picking the next Dallas hospital.
5. **Texas Health Presbyterian Hospital Dallas** (Texas Health Resources).
6. **Children's Medical Center Dallas** (Children's Health) -- pediatric specialty, same diversity rationale as Texas Children's in Houston.

## San Antonio

Still untouched -- was part of the original pilot-scope agreement (Austin + other major TX metros) but Houston/Dallas got worked first. No candidate list built yet; flag if/when it's time to start one.

Sources: [Houston hospital rankings](https://www.beckershospitalreview.com/rankings-and-ratings/100-of-the-largest-hospitals-and-health-systems-in-the-us-2026/), [Dallas hospital rankings](https://www.dmagazine.com/healthcare-business/2026/08/healthcare-briefs-top-hospitals-2026/), [DFW largest hospitals by bed count](https://destinationdfw.com/DFWs-Largest-Hospitals-in-the-Metroplex/).
