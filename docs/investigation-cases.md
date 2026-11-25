# Investigation cases (A0)

Status: draft for #133 milestone A0, for review by the A0 owner (dismasfriday) and the operator evaluator (arindahills). Figures are from `main` at `0f3ad0c0`, computed with `computeSiteDay` over the fixture provider's samples.

This document gives #133's first slice its labelled cases, the answer each case expects, three worked example answers, the deterministic fixture set the cases run on, and the manual baseline procedure. It sets the rules that decide when a result escalates, which `docs/investigation-evidence.md` (§5) leaves to this step, and records how A3's proposed acceptance was ratified. Evidence and result shapes are those of `site-day-evidence/1` and `site-day-result/1` in that document; this one adds no field.

All cases and their answers are public, as #133's A3 acceptance requires: the deterministic investigator and the agent are built with them in view, and the manual baseline is not blind.

## 1. The fixture set

### Installation

One disposable installation with `MGM_METERING_FIXTURES` on (docs/setup.md, "Synthetic site data"), so the `synthetic` provider serves every microgrid below. Every value here is pinned, because the generator keys a day on `SITE_FIXTURE_SEED`, the microgrid's UUID and the date, and house meters on the device's UUID (`src/lib/metering/fixture/site-samples.ts`); a case named only by microgrid and date would not reproduce on another installation.

| Item | Pinned value |
|---|---|
| `SITE_FIXTURE_SEED` | `mgm-fixture-site-v1` |
| Resolution | 5 minutes |
| Organization A | `00000000-0000-4000-8000-0000000c00a0`, every plugin at its default |
| Organization B | `00000000-0000-4000-8000-0000000c00b0`, metering turned off (case C14) |
| One community per organization | `…0000000c00a1` and `…0000000c00b1` |
| Microgrid *n* (n = 1…10, hexadecimal) | `00000000-0000-4000-8000-0000000c00nn`; microgrid 0a is organization B's, all others organization A's |
| Time zone | `Africa/Kampala`, except microgrid 02 (`Europe/London`) and microgrid 06 (`Not/AZone`, stored as text; `openSiteQuery` falls back to UTC for a zone it cannot use) |
| Edge of microgrid *n* | One edge, `SYNTHETIC-EDGE-CASE-nn` (decimal), except microgrid 09, which also has a real edge, `edge0` |

### Devices

Every microgrid starts from the full set below; §2 lists each microgrid's changes. Device *dd* of microgrid *nn* has the UUID `00000000-0000-4000-8000-0000000cnndd`.

| *dd* | Type | Component id | Tenant link |
|---|---|---|---|
| `01` | `battery` | `ess0` | none |
| `02` | `grid_meter` | `meter0` | none |
| `03` | `inverter` | `inverter0` | none |
| `11` | `consumption_meter` | `meter1` | Unit 1's primary consumption meter from 2026-01-01, open-ended |
| `12` | `consumption_meter` | `meter2` | Unit 2's, as above |
| `13` | `consumption_meter` | `meter3` | Unit 3's, as above |

Units are `tenants` rows named `Unit 1` to `Unit 3` on the device's own microgrid, with no contact details. Device names do not affect the cases (one device per site type, so `pickSiteSources` never chooses by name) and never reach evidence.

### Variants

| Microgrid | Change from the full set | Used by |
|---|---|---|
| 01 | none | C01–C05 |
| 02 | zone `Europe/London` | C06 |
| 03 | no battery | C07 |
| 04 | no grid meter | C08 |
| 05 | meter `13` has no component id | C09 |
| 06 | zone `Not/AZone` | C10 |
| 07 | adds device `04`, `pv_meter`, with no component id | C11 |
| 08 | no battery and no grid meter | C12 |
| 09 | a second, real edge `edge0` | C13 |
| 0a | in organization B, where metering is off | C14 |

Pending cases (§2) get microgrids `…0c0011` onwards, pinned when their scenarios land.

### Rules that keep the set deterministic

- **A pin never moves.** Scenarios are picked by cumulative weights (`SCENARIOS` in site-samples.ts), so a new weight changes the scenario of any pinned date whose draw falls in the moved range. The pending scenarios therefore do not join that list: each is selected by its own hash, or by a pinned (microgrid, date) table in the fixture, so every case below keeps its scenario. The regeneration test (below) fails if one moves.
- **Finished days only.** Every date is in the past and finished in its zone, as investigation creation requires (`window_not_closed`, evidence §3 O2).
- **Synthetic only.** Every edge id starts with `SYNTHETIC-EDGE-`, except microgrid 09's `edge0`, which exists to be refused.

Two pieces of code make the set usable, and both are tasks in the A1/A2 split, not part of this document. A **seed script** inserts the pinned rows on a disposable installation, for the manual baseline and for local runs. A **regeneration test** rebuilds each existing case from its pins, asserts the scenario and the figures in §2, and, once A2's capture method exists, the evidence keys and the expected result.

## 2. Cases

Mechanism: **exists** is a generator scenario, a source configuration or a refusal that `main` produces today; **pending** needs a fixture scenario from evidence §11 change 6, or another named change, before it can run.

Positions are minutes after the local day's start, `[start, end)`, as in evidence §4. "Summary" lists the `summary` figures that differ from a clear day: `darkMin` 0, `noDataMin` 0, `knownMin` 1440, `lightsOnPct` 100, `cutMin` 0, `metersLeftOut` 0.

### Normal behaviour

| Case | Microgrid, date | Mechanism | Expected evidence | Expected result |
|---|---|---|---|---|
| C01 Clear day | 01, 2026-09-04 | exists: `clear` | No range items. Summary: as clear; `tenantMetersEveningKwh` 6.72 | `answered`, no findings |
| C02 Evening cut, battery carries the load | 01, 2026-09-01 | exists: `evening-cut` | No range items: the grid was cut at [1150, 1240) (19:10–20:40) but the battery never reached its floor. Summary: `cutMin` 90; `tenantMetersEveningKwh` 6.77 | `answered`, no findings |
| C03 Long cut, dark after the cut | 01, 2026-09-02 | exists: `long-cut-dark` | `dark_cut` [[1185, 1350]] (19:45–22:30), decided by a 0 V reading inside the cut that began at 1110. Summary: `darkMin` 165, `darkInferredMin` 0, `lightsOnPct` 88.54, `cutMin` 240; `tenantMetersEveningKwh` 3.08 | `answered`; findings `dark_known_cut` |
| C04 Battery floor at dawn | 01, 2026-10-01 | exists: `floor-at-dawn` | `dark_lowbat` [[300, 390]] (05:00–06:30), decided by the last SoC, at the 15% floor. Summary: `darkMin` 90, `darkInferredMin` 90, `lightsOnPct` 93.75, `cutMin` 90; `tenantMetersEveningKwh` 6.71 | `answered`; findings `dark_low_battery` (§4, example 1) |
| C05 Gateway gap | 01, 2026-09-15 | exists: `gateway-gap` | `no_data` [[600, 645]] (10:00–10:45), `ruledOut` the last voltage and SoC before it. Summary: `noDataMin` 45, `knownMin` 1395; `tenantMetersEveningKwh` 6.68 | `answered`; findings `no_data`; hypothesis `gateway_or_link_down`, `confirmBy` `provider_history`. 45 minutes is under rule R3's 120 |
| C06 Clock-change day | 02, 2026-10-25 | exists: `clear` in `Europe/London`, which leaves summer time that day | `window.bins` 300. Summary: `knownMin` 1500; `tenantMetersEveningKwh` 6.63 | `answered`, no findings |
| C11 Solar meter without identifiers | 07, 2026-09-01 | exists: configuration | `src_pv` `unavailable`, `source_not_readable`. Otherwise clear; `tenantMetersEveningKwh` 6.68 | `answered`, no findings: an unreadable solar meter limits nothing (evidence §5) |
| C22 Flat meter over the evening | pending | pending: a tenant meter whose counter does not move in the evening | The meter counted at 0 kWh, in `meter_readings` with no outcome | `answered`, no findings (evidence Q9) |

### Insufficient evidence

| Case | Microgrid, date | Mechanism | Expected evidence | Expected result |
|---|---|---|---|---|
| C07 No battery registered, gap at the floor | 03, 2026-09-11 | exists: configuration on a `floor-at-dawn` day | `src_battery` `unavailable`. The day has a gap at [300, 390), so `dark_lowbat`, `dark_after_lowbat` and `no_data` are stored `unavailable`, `input_unavailable`, `in: ["src_battery"]`; `dark_cut` has no range and is left out. Summary: `darkMin`, `noDataMin`, `knownMin` and `lightsOnPct` `null`; `cutMin` 0; `tenantMetersEveningKwh` 6.73. (`computeSiteDay` alone reads the gap as 90 minutes of no-data time, since without a battery nothing says it was dark.) | `evidence_limited`; findings `source_unreadable` |
| C08 No grid meter, dark evening | 04, 2026-09-03 | exists: configuration on a `long-cut-dark` day | `src_grid` `unavailable`. The day has a gap at [1180, 1350), so all four range items are stored `unavailable`, `in: ["src_grid"]`. Summary: range figures `null`, `cutMin` `null`; `tenantMetersEveningKwh` 2.99 | `evidence_limited`; findings `source_unreadable` (§4, example 2). Without the grid meter nothing tells a cut from a battery at its floor |
| C09 Linked meter without identifiers | 05, 2026-09-03 | exists: configuration | `m_unreadable` with device `…0c0513`. Summary: `metersLeftOut` 1, `tenantMetersEveningKwh` 6.73 (two meters) | `evidence_limited`; findings `meter_unreadable` |
| C10 No usable stored zone | 06, 2026-09-01 | exists: configuration | `window.zone` `fallback`, `caveat` `["zone_fallback"]`; the day is read in UTC. Otherwise clear; `tenantMetersEveningKwh` 6.74 | `evidence_limited`, no findings (the caveat alone limits the answer) |
| C12 No battery or grid meter | 08, 2026-09-01 | exists: refusal `metering_no_site_devices` | A refused read: `read` with reason `no_site_devices` | `evidence_limited`; findings `refusal` |
| C13 Synthetic and real edges | 09, 2026-09-01 | exists: refusal, `METERING_CONFIGURATION` 409 | `read` with reason `mixed_edges` | `evidence_limited`; findings `refusal` |
| C14 Metering off | 0a, 2026-09-01 | exists: refusal `metering_disabled` | `read` with reason `metering_disabled` | `evidence_limited`; findings `refusal` |
| C20 Provider outage | pending | pending: the provider refuses the read as unavailable | `read` with reason `provider_unavailable` | `evidence_limited`; findings `refusal` |

### Missing and anomalous readings

| Case | Microgrid, date | Mechanism | Expected evidence | Expected result |
|---|---|---|---|---|
| C15 Meter silent at the evening's start | pending | pending: one tenant meter reports nothing from 17:20 to 18:05, which covers the whole start search (bins 209–216, 17:25 to 18:05; evidence §4 `meter_window`) | `meter_readings` with `start` `null` for that meter; `meter_outcomes` `no_start` | `escalation`, `field_technician` (R2); findings `meter_no_reading`; hypothesis `meter_comms_loss`, supported by the other meters' readings in the same bins |
| C16 Meter silent at the end, gateway down too | pending | pending: one meter silent from 23:20, and a site-wide gap from 23:20 to midnight | That meter `no_end`; `no_data` covering its end window | `evidence_limited` (a contested hypothesis); findings `meter_no_reading` and `no_data`; `meter_comms_loss` with the `no_data` range in `against`, and `gateway_or_link_down`. The contradictory-evidence case |
| C17 Evening counter reset | pending | pending: one meter's counter resets at 20:00 | That meter's `end` below its `start`; `meter_outcomes` `backwards` | `escalation`, `field_technician` (R1); findings `meter_backwards`; hypothesis `meter_counter_reset_or_replaced` (§4, example 3) |
| C18 Some unreadable timestamps | pending | pending: 20 of the day's timestamps unreadable, 14:00–15:40 | `timestamps.dropped` 20; `no_data` over the dropped bins | `escalation`, `ems_vendor` (R4); findings `unreadable_timestamps` and `no_data`; hypothesis `gap_from_unreadable_timestamps` |
| C19 Mostly unreadable timestamps | pending | pending: more than half the timestamps unreadable | A refused read: `read` with reason `provider_unreadable_timestamps` | `escalation`, `ems_vendor` (R4); findings `unreadable_timestamps` |
| C21 Gap across midnight | pending | pending: a site-wide gap from the previous day's 23:00 to 03:00 | `no_data` from position 0 to 180, `ruledOut` from the carry-in | `escalation`, `field_technician` (R3); findings `no_data`; hypothesis `gateway_or_link_down` |
| C23 Two meter problems on one day | pending (half exists) | meter `13` without identifiers (configuration) and a counter reset on meter `12` (pending) | `m_unreadable` and `meter_outcomes` `backwards` | `escalation`, `field_technician` (R1); findings `meter_backwards` and `meter_unreadable` |
| C24 Provider returns data MGM cannot use | pending | pending: the provider answers with series of the wrong length | A refused read, `provider_invalid_data` | `escalation`, `ems_vendor` (R5); findings `refusal` |

That is 24 labelled cases: 14 exist today and 10 are pending. Every slice category of evidence §7 appears, and so does every outcome and every escalation role but `mgm_maintainer`, which only a defect in MGM produces (R6) and which no fixture should simulate.

### Operation cases, for A2's tests

These exercise the operation rather than an answer, so they are A2's database-backed tests, not cases for the three arms.

| Case | Expected |
|---|---|
| Today's date | Creation refused, `window_not_closed`; no operation |
| The zone changed after creation | The capture stores nothing and the operation fails `window_changed` |
| A retry with the same attempt key | The stored record, whatever the operation's state |
| Three refused reads | The third fails the operation, `no_successful_read` |
| A snapshot over 128 KiB (about 500 tenant meters) | The operation fails, `evidence_too_large` |
| Cancelled, then a capture | Refused; the operation stays `cancelled` |
| Running for 90 days | The next creation's retention pass ends it as `expired` |

## 3. When a result escalates

Evidence §5 sets the outcome: `escalation` when `escalateTo` names a role; else `evidence_limited` when an item limits the answer, a hypothesis is contested or the zone fell back; else `answered`. It leaves to this step which findings name a role. Decided by tushabe on 25 November 2026:

| Rule | When | `escalateTo` |
|---|---|---|
| R1 | A `meter_backwards` finding | `field_technician`: the counter was reset or the meter replaced, which only a site visit confirms, and the bill depends on it |
| R2 | A `meter_no_reading` finding whose `meter_comms_loss` hypothesis is not contested | `field_technician` |
| R3 | A `no_data` finding when `summary.noDataMin` is at least 120 | `field_technician`: two hours without data from the whole site is more than a link dropping out |
| R4 | An `unreadable_timestamps` finding, from dropped timestamps or the refusal | `ems_vendor` |
| R5 | A `refusal` finding with reason `provider_invalid_data` | `ems_vendor` |
| R6 | A `refusal` finding with reason `calculation_failed`, `internal_error` or `unknown_refusal` | `mgm_maintainer` |

When several rules apply, the result names one role, in this order: `mgm_maintainer`, `ems_vendor`, `field_technician`, since a defect in MGM or in the data path can produce what looks like a site fault. Nothing else escalates. A dark day, an unreadable source or meter, and the other refusals are configuration or explanation the operator acts on directly, so they are `answered` or `evidence_limited`.

## 4. Example answers

Each result is what the deterministic investigator writes. "Reads as" is what the operator should take from it; it is not stored (results hold no free text), and A3's model text is not part of it. `<e1>` is the evidence record's id.

### Example 1: answered (C04)

```json
{ "schema": "site-day-result/1", "outcome": "answered", "escalateTo": null,
  "findings": [ { "cat": "dark_low_battery", "cites": ["<e1>#/items/dark_lowbat"] } ],
  "hypotheses": [], "unavailable": [] }
```

Reads as: the houses were dark from 05:00 to 06:30; the battery was at its 15% floor when the site went quiet, so the battery, not the gateway, explains the gap. Nothing on the day contradicts that, and no data is missing.

### Example 2: evidence-limited (C08)

```json
{ "schema": "site-day-result/1", "outcome": "evidence_limited", "escalateTo": null,
  "findings": [ { "cat": "source_unreadable",
                  "cites": ["<e1>#/items/src_grid", "<e1>#/items/dark_cut", "<e1>#/items/dark_lowbat",
                            "<e1>#/items/dark_after_lowbat", "<e1>#/items/no_data"] } ],
  "hypotheses": [],
  "unavailable": [ { "cites": ["<e1>#/items/src_grid"] }, { "cites": ["<e1>#/items/dark_cut"] },
                   { "cites": ["<e1>#/items/dark_lowbat"] }, { "cites": ["<e1>#/items/dark_after_lowbat"] },
                   { "cites": ["<e1>#/items/no_data"] } ] }
```

Reads as: the site had no data from 19:40 to 22:30, but with no grid meter registered MGM cannot tell whether that was a grid cut, a battery at its floor, or the gateway; register the grid meter under Setup → Edges to answer it.

### Example 3: escalation (C17)

```json
{ "schema": "site-day-result/1", "outcome": "escalation", "escalateTo": "field_technician",
  "findings": [ { "cat": "meter_backwards", "cites": ["<e1>#/items/meter_outcomes/<meter>"] } ],
  "hypotheses": [ { "code": "meter_counter_reset_or_replaced", "finding": 0,
                    "supports": ["<e1>#/items/meter_readings/<meter>"], "against": [],
                    "confirmBy": "field_check" } ],
  "unavailable": [] }
```

`<meter>` is the reset meter's device id, pinned when the scenario lands. Reads as: that meter's counter ended the evening lower than it began, so it was reset or replaced; it is left out of the evening total, and a field technician should check it before the unit is billed.

## 5. Manual baseline procedure

The manual baseline is the first of A3's three arms: an operator answering each case with what MGM shows today, timed and scored against §2.

**Who.** The operator evaluator, arindahills. The answers are public, so this measures time and what MGM's screens make visible, not independent judgement; A3's evidence packet says so.

**Setup.** A disposable local installation (docs/setup.md) with `MGM_METERING_FIXTURES` on, loaded by the seed script, and the operator signed in as an organization manager of both organizations. No production system and no real data.

**For each existing case, in order:**

1. Start a timer. Open the microgrid's Operations tab at the case's date.
2. Use only what MGM shows: the Operations day view, Setup → Edges and its device list, and the tenants list. Nothing outside MGM; there is no OpenEMS behind a synthetic microgrid.
3. Write the answer in the result's vocabulary: an outcome, a role if escalating, the finding categories, and any hypothesis codes. Note each claim about the day and the screen and figure it rests on.
4. Stop the timer.

**Scoring,** by someone other than the operator, against §2: outcome and role exactly; findings and hypotheses as sets; and unsupported claims, a claim with no figure behind it. Record per case the minutes taken, each field right or wrong, the count of unsupported claims, and whether it escalated.

**Limits to record, not fix.** The Operations day view shows how many tenant meters were left out of the evening total, not which ones or why, and shows a refused read as a problem message. The manual arm therefore cannot name the meter in C09, and answers the refusal cases (C12–C14) from that message. Those are results of the baseline, not defects in it. The pending cases are run once their scenarios exist, before A3's comparison.

**Where it goes.** A comment on #133, or on A3's tracking issue once A3 is activated, with the commit and seed it ran on. Synthetic data only.

## 6. A3's proposed acceptance, ratified

#133 asks A0 to ratify or amend A3's proposed acceptance against these cases. Ratified with these amendments by tushabe on 25 November 2026, and recorded in #133's A3 section:

1. **At least 20 labelled synthetic scenarios.** Ratified: 24, in §2. Amend its list: "missing/stale samples" becomes "missing samples", because the slice reads only finished days (evidence §3 O2), so no sample can be stale. "Mixed units/time zones" becomes "time zones (a clock-change day and a zone fallback)", because units are fixed by the provider contract and the evidence schema (evidence §4), and a unit error is a provider defect for the provider's own tests, not an investigation case.
2. **Public cases and answers.** Ratified; this document is that.
3. **Every reported numerical fact has a reference.** Ratified. A result holds no figures of its own (evidence §2, rule N), so this applies to A3's model text: each figure in it must resolve to a citation, or be shown as unverified.
4. **Scope, gating, cancellation and human-only tests.** Ratified, with §2's operation cases among them.
5. **The operator rubric.** Per case, outcome and role exact, findings and hypotheses as sets, and unsupported claims counted. Correct abstention means `evidence_limited` where §2 expects it, without a guessed cause. The rubric is agreed before the first model run.
6. **Three arms on the same cases.** Ratified, with §5 as the manual arm. A case pending at comparison time is left out of all three arms, and the evidence packet lists it.
7. **Release only if the agent beats the deterministic investigator.** Ratified.
8. **Failure keeps the agent experimental and read-only.** Ratified.

## 7. Open, with owners

The escalation rules R1–R6, R3's 120-minute threshold (evidence Q8) and the amendments in §6 were decided by tushabe on 25 November 2026.

| Question | Proposal | Decision owner |
|---|---|---|
| How pending scenarios are selected without moving pins (§1) | A separate hash, or a pinned (microgrid, date) table in the fixture | Whoever builds evidence §11 change 6 |
