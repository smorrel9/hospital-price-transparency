# Hospital queue

Backlog of candidate hospitals for the pilot expansion, so there's always a next pick ready without re-researching from scratch. Not verified manifest entries -- that's what `hospital-discovery` does when a hospital actually gets picked up. Bed counts/rankings via web search 2026-10-12, worth a sanity-check if this list is used much later (hospital systems merge/rename).

**Status tracking lives in GitHub Projects, not here:** [Hospital Onboarding Queue](https://github.com/users/smorrel9/projects/1). This file stays the research/rationale reference (naming traps, diversity notes, sources) -- check off a hospital in the Project when it ships, don't maintain a parallel status table here.

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

## San Antonio queue

1. **Methodist Hospital (San Antonio)** -- 1,536 beds, Methodist Healthcare System, ranked #1 locally and #12 in Texas (2026-2027). One of the largest hospitals in the US by bed count. **Naming trap**: see "Naming traps" below -- this is a *third* distinct "Methodist" entity, not the same organization as Houston Methodist or Methodist Dallas Medical Center.
2. **University Hospital** (University Health System) -- 716-bed teaching hospital, South Texas Medical Center. Third-largest public health system in Texas -- same safety-net-diversity rationale as Ben Taub/Parkland.
3. **Baptist Medical Center** (Baptist Health System San Antonio) -- ranked #2 locally for 2026-2027.
4. **Methodist Hospital Stone Oak** -- also Methodist Healthcare System (same system as #1), ranked #3 locally. Lower priority as a second pick from a system already represented, same rationale as Houston Methodist's other campuses.

## El Paso queue

1. **University Medical Center of El Paso (UMC)** -- El Paso's only not-for-profit, community-owned hospital; the region's only Level 1 Trauma Center and certified Comprehensive Stroke Center. Public/safety-net profile, same diversity rationale as Ben Taub/Parkland/University Hospital (San Antonio).
2. **Las Palmas Medical Center** -- part of Las Palmas Del Sol Healthcare (HCA-affiliated).
3. **Del Sol Medical Center** -- also Las Palmas Del Sol Healthcare, same system as #2 -- lower priority as a second pick from the same system.
4. **The Hospitals of Providence** -- multi-campus system (e.g. Transmountain), part of a larger regional system (9 hospitals per Becker's).
5. **El Paso Children's Hospital** -- pediatric specialty, same diversity rationale as the other children's hospitals in this queue.

## Amarillo queue

Smaller market -- really just two major systems, not padding this out to match the others' list length:

1. **Northwest Texas Healthcare System** (Northwest Texas Hospital) -- 495 beds, largest in the Panhandle by revenue, part of Universal Health Services (UHS).
2. **BSA Health System** (Baptist St. Anthony's Health System) -- second-largest, largest healthcare employer in the Texas Panhandle region.

## Naming traps

Texas hospital branding reuses a handful of names across completely unrelated organizations. Worth a deliberate check before assuming a hospital is already covered or already researched:

- **"Methodist"** -- three distinct organizations, none affiliated with each other: Houston Methodist (`houston-methodist`, already in the pipeline), Methodist Health System / Methodist Dallas Medical Center (Dallas queue), and Methodist Healthcare System / Methodist Hospital (San Antonio queue).
- **"Baylor"** -- two distinct organizations: Baylor Scott & White Health (already in via `bsw-austin`, also has the Dallas flagship Baylor University Medical Center in the Dallas queue), and Baylor St. Luke's Medical Center / CHI St. Luke's Health (CommonSpirit, Houston queue) -- a licensing/naming relationship with Baylor College of Medicine, not the same health system as Baylor Scott & White.

Sources: [Houston hospital rankings](https://www.beckershospitalreview.com/rankings-and-ratings/100-of-the-largest-hospitals-and-health-systems-in-the-us-2026/), [Dallas hospital rankings](https://www.dmagazine.com/healthcare-business/2026/08/healthcare-briefs-top-hospitals-2026/), [DFW largest hospitals by bed count](https://destinationdfw.com/DFWs-Largest-Hospitals-in-the-Metroplex/), [San Antonio hospital rankings](https://www.sahealth.com/about-us/newsroom/methodist-healthcare-hospitals-named-among-best-hospitals-in-san-antonio-and-texas), [University Health San Antonio](https://en.wikipedia.org/wiki/University_Health), [El Paso hospital systems](https://www.definitivehc.com/resources/healthcare-insights/IDNs-Texas-number-hospitals), [UMC El Paso](https://www.umcelpaso.org/about-us/the-hospital), [Amarillo health systems](https://nwths.com/about/).
