# ADR-049 — Campaign policy v2: the rules the six announcements actually print

**Status:** Accepted (policy model and the three owner defaults) · 2026-10-29 (S12c) · identity read and sandbox parts: see the S12c PRs
**Deciders:** platform owner for the three defaults marked *default taken, owner to confirm*
**Relates to:** ADR-007 age, ADR-012 walk-in, ADR-030 campaign-bound submission, ADR-032 document requirements, ADR-047 G2G sandbox, ADR-048 binding and clearance; **Campaign Studio (S05)**
**Source of campaign facts:** `docs/product/recruitment-announcements-2025-2026.md` only. The English translations are never a source.

## 1. Context

Policy v1 expresses, per category: one age window, one education threshold, one criminal threshold, a document list and a medical mode. The announcements need more, and S12a recorded each gap as a `POLICY_MODEL_GAP` note:

- age caps that differ by qualification (RDF Reserve 25 / 26 / 27; RCS officer 25 and 27);
- education alternatives (A0 *or* A1 IPRC) and minimums below A2 (S3);
- the conviction rule as policy, and "not under prosecution" (RCS);
- the documents list with how each is satisfied, and notarisation (RCS);
- clearance values (accepted certificate types, validity window), which ADR-048 left in process configuration;
- two-day district sittings and venues shared by several districts.

Two things were also true of v1 that matter here. The eligibility engine evaluated static constants, not the published policy, so a published policy could advertise a rule the engine did not enforce. And Campaign Studio (S05) is being built against the v1 shape.

## 2. Decision

### 2.1 An additive, versioned `v2` block (v1 keeps working)

Each category policy keeps all six v1 fields and may add **`v2`**:

| `v2` field | Meaning |
|---|---|
| `schemaVersion` | `2` |
| `ageBands[]` | `{qualifications[], minimumAge, maximumAge}`. A qualification is an education level or `FIELD:<specialist field>`. Of the bands an applicant's verified qualifications match, the **most generous** applies. |
| `educationAlternatives[]` | `{level}`; **any one** satisfies; a level means "at or above on the ladder", which gives the S3 minimum and A0-or-A1. |
| `minimumSciencePercent` | the 70% bar (RCS four-year), or `null` |
| `conviction` | `{rule: NEVER_CONVICTED \| NO_SENTENCE_6M_OR_MORE \| NO_SENTENCE_OVER_6M, notUnderProsecution}` |
| `documents[]` | `{type, satisfaction: REGISTRY_VERIFIED \| UPLOAD \| PRESENT_AT_VENUE, notarised}` (ADR-032) |
| `clearance` | `{allowedCertificateCodes[], noRecordCertificateCodes[], validityDays}` or `null` |

Rules that keep the two shapes honest, enforced when the policy is written:

1. **The v1 envelope may not contradict `v2`.** v1 `age` equals the widest v2 band; v1 `criminalThreshold` equals the threshold of the v2 conviction rule; v1 `requiredDocumentTypes` is exactly the v2 document types. A v1 reader (Campaign Studio, the checklist, the document door) therefore sees a true, if coarser, policy. Violation: `POLICY_V2_ENVELOPE_MISMATCH`.
2. The block is normalised to a canonical order, so authoring order never changes the hash.
3. **Hash and immutability are unchanged.** The policy hash covers the whole document, `v2` included (ADR-030). `hash_version` stays 1; no column is added. `rls/0041_campaign_policy_v2.sql` adds a CHECK as a database-level guard so a write that bypasses the service cannot store a malformed `v2`.
4. The pure rules live in `packages/shared-campaign-policy` (zero dependencies): `normalizePolicyV2`, `ageBandFor`, `evaluateAgeForQualification`, `educationSatisfied`, `scienceSatisfied`, `convictionVerdict`, `documentPlan`, `checkEnvelope`.

### 2.2 The six campaigns are published from the announcement

A scenario encoded from an announcement derives each category's policy from its printed facts (`policyFromAnnouncement`), so the publication preflight accepts the policy "as printed". The sandbox's legal basis stays `SYNTHETIC-REHEARSAL`; the clearance certificate codes remain the placeholder codes of ADR-048 §2.5 until RIB/Irembo give the real ones.

### 2.3 Owner decisions (default taken, owner to confirm)

| Decision | Default taken |
|---|---|
| RCS walk-in on exam day (the RCS officer announcement says yes) | **OFF** until the agency confirms. RDF 2026 walk-in is ON as printed. `allowsWalkIn` is already per campaign; no model change is needed to turn it on. |
| Identity fields shown to the citizen | names, sex, date of birth, place of birth, nationality, district of residence. **Never** photo, signature, parents' names, or the full National ID. |
| Health questions | **never asked in the portal**; the medical station only (DPIA). |

## 3. Which gaps are closed, which remain

| Gap (S12a note) | State |
|---|---|
| Age caps by qualification within one category | **Modelled and unit-proven** (`ageBands`, most-generous-band rule). The engine still enforces the per-category window from constants; wiring the pinned policy into the age and academic gates is the follow-up recorded in section 4. |
| Education alternatives, S3 minimum, 70% science bar | **Modelled and unit-proven.** |
| Conviction rule as policy, not-under-prosecution | **Modelled and unit-proven** (`convictionVerdict`). The Irembo certificate cannot show a prosecution; an officer reading of the record supplies the facts (ADR-048 known gap 1). |
| Documents with satisfaction mode, notarisation | **Modelled; published for all six campaigns.** The catalogue still has no notarised A2 type; `notarised` is carried and checked at the venue. |
| Clearance values per campaign | **Published in policy.** Passing them to the vetting service per application is part of section 4. |
| Walk-in per campaign | **Already per campaign**; the RCS default is recorded above. |
| Two-day district sittings | **Remains.** BUILD-001 allows one session per district (`idx_pc_venue_campaign_district`); relaxing it touches scheduling, the slot ledger and the device registry. |
| Shared multi-district venue capacity | **Remains**, same reason. |
| Barred list, "dismissed from public service" | **Remain** (no registry); they rest on documents and officers. |

## 4. Consequences and follow-up

- Campaign Studio keeps working unchanged: it writes v1, and a v2 policy it reads still has a truthful v1 envelope. To author v2 it adds the `v2` block to the same `POST /edge/v1/campaigns/policy` body.
- A v1-only campaign behaves exactly as before.
- **Not yet enforced by the engine:** the age and academic gates, and the vetting service's clearance values, still read constants and process configuration. Reading the application's pinned policy there (the eligibility service can already select it: rls/0030) is the next step, and until it lands a published v2 policy is a faithful *statement* of the rules, not their enforcement. The sandbox journeys that assert a refusal (A0 aged 27, science 69%) depend on it.
