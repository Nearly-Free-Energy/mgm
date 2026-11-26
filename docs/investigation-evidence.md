# Investigation evidence (A0)

Status: draft for #133 milestone A0. File and line references are at `6cb83bdb`. #263 has since put changes 3 and 4 (§11) on `main`, and #264 gave a source without site samples its own refusal code (§6); this document takes both as current behaviour. #258 added `OPENEMS_ID_PATTERN` and its database check (§4).

A logical design, stated as requirements on A2, which builds the records, with a pointer to ADR-007 for the model data boundary. It contains no SQL.

## 1. Scope

#133's first slice: one microgrid, one finished local day, read through `MeteringCapability.getSiteDay` (src/lib/metering/capability.ts:712-760), which computes the day in `computeSiteDay` (src/lib/metering/site-operations.ts:329-604) from 5-minute samples. Out of scope: multi-day windows (#133 fixes the slice at one day; `getSiteDays`, from #102, reads several, but only the `billing.savings` view calls it, to value the day's savings, the month's so far and those since savings were first counted, over up to 366 days (src/lib/billing/surface/savings.ts:113; src/lib/billing/site-savings.ts:82-92), and no view shows a multi-day window's site figures), billing-period readings (#26), unattended work. Stop rule: a field is here only if a slice category (§7) or an A2 exit needs it.

## 2. The four kinds

| Kind | Definition | Lives in |
|---|---|---|
| `fact` | A value as the metering provider returns it to the capability, or MGM's configuration as read: a reading, a source device, a refusal's status and code. Not computed by the capability or the operation. Where the provider derives a value (`gridV`, §4), the derivation is part of the field's definition and is stated in §4. | Snapshot |
| `calculated` | A deterministic function of facts under a named calculation version. | Snapshot |
| `unavailable` | Something the investigation needed and did not get, with a reason code (§6). | Snapshot |
| `hypothesis` | An explanation the facts do not establish, from a closed list, citing what supports and what contradicts it. | Result (§5) |

- **H.** A snapshot never holds a hypothesis, and no calculated value cites one.
- **N.** An A2 result carries no measured or calculated values of its own (its only integers are indexes into its own lists); each value a reader sees resolves through a citation to a `fact` or `calculated` item. That makes A3's proposed criterion ("Every reported numerical fact has a source or deterministic calculation reference") checkable, not satisfied: A3 must still check model-written text against citations, and ratifying A3's acceptance belongs to the cases step.
- **Z.** A missing figure is `null` or an `unavailable` item, never 0, as in `SiteDayOperations` (site-operations.ts:177-180). A calculated item with an unavailable input is `unavailable` with reason `input_unavailable`; within `summary`, which gathers several figures, a figure with an unavailable input is `null` instead (§4).
- **Quality** is expressed by the kind, the reason code and a closed `caveat` list on `window`, whose one value at `@1` is `zone_fallback` (§4); no item carries a caveat at `@1`. There is no other quality field.
- **Escalation** is a kind of result (§5), not a statement kind or a lifecycle state.

**Who attests a fact.** Through A3 every step runs in the signed-in operator's own session, with nothing on the service role (#133, A2). The snapshot's content is read from the metering provider in TypeScript and reaches the database as an argument of a write function that the operator's own token may call. The database can check the content's shape, the caller's access and the operation's state (E1), not that the values came from the provider. So a stored fact is attested by the capturing operator's session, not by MGM: an operator with access to a microgrid could store readings of a valid shape that the provider never returned, for that microgrid only. This is accepted through A3 because that person already holds org access to the microgrid, its configuration and its billing; evidence explains what an operation knew to the same organization's staff and is not a record of the site; and the capturer column, which the caller cannot set (E2), traces every record to a person. Revisit before evidence is used as proof against its own capturer, or before anything captures evidence without a signed-in person: either would need a server-held attestation (for example a keyed digest checked on read), with an owner, a runbook entry, and a reconciliation with #133's "nothing on the service role".

## 3. Requirements on A2's records

How A2 meets each requirement is its choice, proved by database-backed tests.

**Operation**

- **O1.** It is linked to one microgrid at creation, never changed, and records its organization as A2's deliverable asks. Access to evidence is decided through the microgrid (§10).
- **O2.** Its window is a date and a zone, fixed at creation. Creation resolves the zone as `openSiteQuery` does (the stored zone, UTC when it is missing or invalid; capability.ts:585-586), records whether it fell back, which the `zone_fallback` caveat marks (§4), and refuses a date not before today in that zone with `window_not_closed` (§6; the capability itself accepts today, capability.ts:717). A failed zone read is refused (`metering_timezone_unavailable`, change 4): creation reports that refusal (§6) and makes no operation. The capture method returns the zone it used and whether it fell back, on a refusal too, unless the refusal came before or at the zone read. The capture function compares them with the operation's only after the checks that come first: E1's access and plugin checks, then E4's attempt-key lookup (a retry gets the stored record whatever the operation's state), then the state check and the rest of E4 (nothing is captured after a successful read). Then:
  - no zone (a refusal before or at the zone read): the refusal is stored as E4 says, in the operation's window (a refusal of the person stores nothing, §6);
  - the same zone, and the same `window.zone` value: the read is stored or refused as E4 says;
  - another zone, or the same zone with the other `window.zone` value: `window_changed`. It stores no record, uses none of E4's three tries, and ends the operation as `failed` with `window_changed` (O4). A failed zone read reports no zone, so this means a person changed or cleared the microgrid's stored zone. A retry gets the same answer until a person changes the zone back, so the operation does not wait for that; the person starts a new operation for the day.
- **O3.** Status, result and the time the operation ended (read by retention, §8) change only through the write functions (E1), as O4 sets out: the transition and result functions apply the same checks as a capture, a capture may fail the operation (O2, E4, §8), and the retention pass ends an expired operation without those checks and with no actor. The result is written once, on completion, and its citations are capped so that it fits 16 KiB (§5). The result function refuses a larger one with `result_too_large` and leaves the operation `running`: within the caps that is MGM's defect (§5), not the site's, so the step reports it, and the person cancels the operation or writes the result again once the defect is fixed. It refuses a result that would take counted bytes over the budget (§8) with `evidence_budget_full` and leaves the operation `running` the same way: the evidence the result rests on is already stored, so failing the operation would discard a finished investigation for a condition that clears as retention deletes, and the person writes the result again later or cancels. A capture over the budget, by contrast, fails the operation (O4), since the read it needs cannot be stored. Each status change records its actor, which the database sets from `auth.uid()` and the caller cannot supply (as E2); the retention pass records none. Deleting a user only nulls references to them.
- **O4.** An operation's status is `running`, `completed`, `failed` (with a failure code, §6) or `cancelled`. Only these transitions exist; the write functions refuse any other.

  | From | To | Driven by | Write |
  |---|---|---|---|
  | none | `running` | The person starting an investigation, for a window O2 accepts | create |
  | `running` | `completed` | The person's step writing the result (§5) | result |
  | `running` | `cancelled` | The person | transition |
  | `running` | `failed`, `access_refused` | A refusal of the person by the metering capability (§6), recorded by the step. If the write function refuses the person too (E1), nothing is recorded and the operation stays `running` until someone with access cancels it or the retention pass ends it | transition |
  | `running` | `failed`, `no_successful_read` | A capture storing the third record without a successful read (E4) | capture |
  | `running` | `failed`, `window_changed` | A capture whose read used another zone, or the other `window.zone` value (O2) | capture |
  | `running` | `failed`, `evidence_too_large` | A capture whose content is over 128 KiB (§8) | capture |
  | `running` | `failed`, `evidence_budget_full` | A capture that would take counted bytes over the budget (§8); a result over it is refused instead (O3) | capture |
  | `running` | `failed`, `expired` | The retention pass, no sooner than 90 days after creation, with no actor (§8) | create, of another operation |
  | `completed`, `failed`, `cancelled` | deleted, with its evidence | The retention pass, no sooner than 90 days after the operation ended (§8) | create, of another operation |
  | any | deleted, with its evidence | Deleting its microgrid (§9) | none: a cascade |

  A capture that fails the operation for `window_changed`, `evidence_too_large` or `evidence_budget_full` stores nothing, commits the status change and returns the code; it does not raise, which would roll the change back (§8). A capture that stores a record changes no status unless the table says so, and a refused result (`result_too_large`, `evidence_budget_full`, O3) changes none. "Waiting" is not a status: it is a `running` operation whose last read ended before the day did (`window_not_closed`, E4), which stores nothing and changes nothing in the database. It lasts at most `lagMin` past the day's end, since creation refuses today's date (O2), and the step reads again after that.

**Evidence record**

- **E1.** No API role can insert, update or delete the operation or evidence tables directly: each has a `FOR SELECT` policy `TO authenticated, mgm_agent` and nothing else, and INSERT, UPDATE and DELETE are revoked from `authenticated` (ADR-007 decision 3) and from `service_role` (§10). The only write path is one database function per write: create (an operation, which also runs the retention pass, §8), capture (an evidence record), transition (an operation's status) and result. Create checks the caller's access to the microgrid and the plugin for its organization, as below. The retention pass is the one write that touches operations the caller may not read: it runs across all organizations, records no actor, and returns nothing about what it changed. Each function re-checks in SQL what a direct call over PostgREST would otherwise skip:
  - the operation exists, is readable by the caller through `user_can_access_microgrid` on the operation's microgrid, and is running (for capture and result) or in a state the transition may leave;
  - the operations plugin is enabled for the operation's organization, through `mgm_plugin_enabled_for_org`, not only through the TypeScript gate. Not by reading `mgm_plugins` directly: a missing row means the plugin's default, which the function answers and the table does not (20261118140000:192-208). Whether the operations plugin is off by default is A2's choice (§11);
  - the E7 shape, the size bound and the budget (§8);
  - the microgrid and organization ids, which it takes from the operation (E2).

  The function does not establish that the content came from the provider; see "Who attests a fact" (§2). `fn_close_billing_period` (20261118130000:206-303) is not a model for this: it recomputes what it writes from rows the database already holds (:244), while evidence content arrives as an argument. The access and gate checks have a precedent in `fn_delete_draft_billing_period` (20261120130000:83-124): a `SECURITY DEFINER` function that a direct PostgREST call can reach, so it checks `user_can_access_microgrid` itself and only then `mgm_plugin_enabled_for_org`, which tells a caller without access nothing about the organization; the table's DELETE is revoked from `authenticated`.

  These functions are the operations capability's boundary in the database: a direct call enters the capability there, under the same gate and access checks the composer applies, so #133's requirement that every mutation enters its owning capability holds for both ways in. ADR-007 records this.
- **E2.** The database sets who captured a record, when, and its microgrid and organization ids, copying the last two from the operation; a supplied value for any of them is refused. (A composite foreign key on operation and microgrid is an acceptable alternative for the microgrid id.)
- **E3.** Written only while the operation is running; the capture locks the operation, so a capture never commits after a concurrent cancel or completion.
- **E4.** Each capture carries an attempt key chosen by the step. A request retry with the same key returns the stored record, whatever the operation's state (O2), so a retry or a second tab gets one logical result. A new attempt after a refusal uses a new key and makes a new record. At most one successful read and three records per operation; after a successful read no further capture is accepted. A read that ends before the day did (`window_not_closed`, §6) stores nothing and leaves the operation `running`, which is what "waiting" means (O4), so it uses none of the three. A read in another zone, or in the same zone with the other `window.zone` value, stores nothing either, uses none of the three, and ends the operation (`window_changed`, O2). Three records without a successful read end the operation as `failed` with `no_successful_read`.
- **E5.** Immutable: no API role updates or deletes it. The one permitted change is the capturer reference becoming null when that user is deleted; `ON DELETE SET NULL` runs as an update, so any update guard lets exactly that through. Rows go only by retention (§8) and cascade (§9).
- **E6.** Holds its operation, the operation's microgrid and organization ids, the attempt key, schema name, outcome (`read` or `refused`), content (§4), size (§8), capturer and capture time. No foreign key to devices, edges or tenant links: their ids are copied into content as history.
- **E7.** The database checks shape too: known schema name, top-level keys from the allowlist, every snapshot item's `c` one of `fact`, `calculated` or `unavailable`, outcome agreeing with content, the size bound.
- **E8.** The write functions are `SECURITY DEFINER`, owned by `postgres`, pinned to `search_path = public, pg_temp`, with EXECUTE revoked from `PUBLIC, anon` and granted to `authenticated` (CLAUDE.md). Inside them `current_user` is `postgres` (20261118130000:323-327), so they decide by the caller only through `auth.uid()` and the helpers, never by `current_user`. They see every organization's sizes for the budget and return nothing about them. EXECUTE is revoked from `service_role` explicitly unless A2 gives the structural reason to keep it (ADR-007 decision 3; CLAUDE.md); `mgm_agent` is not a member of `authenticated`, so it gets none.

## 4. The snapshot: `site-day-evidence/1`

Example, abridged where marked `…`; each series holds `window.bins` values. Numbers are written as `JSON.stringify` prints them.

```json
{
  "schema": "site-day-evidence/1",
  "window": { "date": "2026-11-10", "tz": "Africa/Kampala", "zone": "microgrid", "t0": 1794258000000, "res": 5, "bins": 288 },
  "units": { "soc": "%", "w": "W", "v": "V", "meter": "Wh", "energy": "kWh", "pct": "%", "pos": "bin", "range": "min" },
  "by": { "calc": 1, "provider": "openems" },
  "params": { "gridMinV": 170, "lowBatPct": 15, "meterTolMin": 30, "eveningStartH": 18, "lagMin": 2 },
  "items": {
    "src_battery": { "c": "fact", "k": "source", "type": "battery", "device": "<d5>", "edge": "edge0", "component": "ess0" },
    "src_grid": { "…": "as src_battery, type grid_meter" }, "src_load": { "…": "as src_battery, type inverter" },
    "src_pv":      { "c": "unavailable", "k": "source", "type": "pv_meter", "reason": "source_not_readable" },
    "carry_in":    { "c": "fact", "k": "carry_in", "gridV": [-1, 231.4], "soc": [-1, 14.8] },
    "series":      { "c": "fact", "k": "series", "soc": […], "batW": […], "gridW": […], "gridV": […], "loadW": […], "pvW": null },
    "timestamps":  { "c": "fact", "k": "timestamps", "dropped": 0 },
    "dark_lowbat": { "c": "calculated", "k": "dark", "cause": "low_battery", "ranges": [[0, 95]], "min": 95,
                     "decidedBy": [ { "ptr": "/items/carry_in/soc/1", "v": 14.8 } ] },
    "no_data":     { "c": "calculated", "k": "no_data", "ranges": [[600, 645]], "min": 45,
                     "ruledOut": [ { "grid": { "ptr": "/items/series/gridV/119", "v": 229.8 },
                                     "soc":  { "ptr": "/items/series/soc/119", "v": 63 } } ] },
    "dark_cut":    { "c": "calculated", "k": "dark", "cause": "known_cut", "ranges": [[1140, 1305]], "min": 165,
                     "decidedBy": [ { "ptr": "/items/series/gridV/227", "v": 0 } ] },
    "meter_window":   { "c": "calculated", "k": "meter_window", "start": [209, 216], "end": [281, 287] },
    "meter_readings": { "c": "fact", "k": "meter_readings",
                        "<d1>": { "component": "meter1", "start": [215, 48211], "end": [287, 48903.5] },
                        "<d2>": { "component": "meter2", "start": [215, 182340], "end": [287, 1200] },
                        "<d3>": { "component": "meter3", "start": [214, 90412.5], "end": null } },
    "meter_outcomes": { "c": "calculated", "k": "meter_outcomes", "<d2>": "backwards", "<d3>": "no_end" },
    "m_unreadable":   { "c": "unavailable", "k": "meters", "reason": "tenant_meter_unreadable", "devices": ["<d4>"] },
    "summary": { "c": "calculated", "k": "summary", "darkMin": 260, "darkInferredMin": 95, "noDataMin": 45,
                 "knownMin": 1395, "lightsOnPct": 81.36, "cutMin": 265, "tenantMetersEveningKwh": 0.69, "metersLeftOut": 3 }
  }
}
```

How it follows the code: the previous day ended at 14.8% with the grid present, so the day starts in a low-battery gap, which ends at the first online bin, 19. Bins 19 and 261 read the grid present (at least 170 V). Bin 119 reads 229.8 V and 63%, so the gap at bins 120–128 is no-data time. Bin 227 reads 0 V, so the gap at bins 228–260 is dark after a known cut. Hence `darkMin` = 95 + 165, `knownMin` = 1440 − 45, `lightsOnPct` = 100 × (1395 − 260) / 1395, and `cutMin` = 95 + 5 + 165 (bins 0–18, carried off after the inferred gap; bin 227; bins 228–260). Only `<d1>` is counted. Summary figures are rounded here for reading.

**Times.** `t0` is the local day's start in epoch milliseconds (2026-11-09T21:00Z here); `bins` differs on clock-change days (fixture/site-samples.ts:7-9). Position `p` is the bin starting `p × res` minutes after `t0`, negative in the previous day. A range is `[start, end)` in elapsed minutes after `t0`. `meter_window`'s pairs are different: inclusive bin positions, so `[209, 216]` searches bin 216. `window.zone` is `microgrid` when the zone is the microgrid's stored zone and `fallback` when `openSiteQuery` used UTC because no valid zone is stored (capability.ts:585-586; a zone that could not be read is refused, change 4); a fallback adds `"caveat": ["zone_fallback"]` to `window`, since every range, the evening window and the meter window then shift by the zone's offset.

**Units and signs.** `units` is a closed map. For `site-day-evidence/1` its keys, the fields they cover and their signs are fixed by this table; a change is a new schema version.

| Unit key | Unit | Fields | Meaning and sign |
|---|---|---|---|
| `soc` | % | `series.soc`, `carry_in.soc` | Battery state of charge |
| `w` | W | `series.batW` | Battery power: + discharge, − charge (src/lib/metering/types.ts:115-118) |
| `w` | W | `series.gridW` | Grid meter power: + import, − export (types.ts:115-118) |
| `w` | W | `series.loadW` | Power drawn at the inverter, as the provider reports it |
| `w` | W | `series.pvW` | Solar meter power, as the provider reports it |
| `v` | V | `series.gridV`, `carry_in.gridV` | The grid meter's lowest phase voltage over the phases that reported, which the provider converts from mV (openems-provider.ts:634-649) |
| `meter` | Wh | `meter_readings` values | A tenant meter's cumulative consumption counter |
| `energy` | kWh | `summary.tenantMetersEveningKwh` | |
| `pct` | % | `summary.lightsOnPct` | Share of known time with power at the houses |
| `pos` | bin | positions | |
| `range` | min | ranges, `min`, `summary.*Min` | |

`summary.metersLeftOut` is a count and has no unit.

Every series and counter value is the provider's value for the bin, which OpenEMS gives as the bin's mean, not an instantaneous reading; a counter's bin value is therefore about its reading at the bin's middle (site-operations.ts:459-462). Values are stored unrounded, as the provider returns them (openems-provider.ts:614-649). `gridV` stays a `fact` with that provenance: the capability receives only the derived value.

**Facts**

- `series`: six site series, the first sample in each bin as `computeSiteDay` takes them (site-operations.ts:371-382); `null` for an empty bin or a series without a source. All six are kept because a bin is online when any of them has a value (site-operations.ts:398), which decides dark and no-data time.
- `carry_in`: the previous day's last non-null voltage and SoC with their positions, all that day contributes (site-operations.ts:364-379).
- Sources: per type, device, edge and component ids, or `unavailable`.
- `meter_readings`: every readable linked tenant meter by device id, with component id and `start`/`end` as `[position, Wh]`. `start` is `null` when its searched bins held no reading; `end` is `null` when its searched bins held none, and also, unsearched, whenever `start` is `null` (site-operations.ts:494-504).
- `timestamps`: the number of provider timestamps dropped as unreadable (change 3), as `getSiteDay` reports it: one figure for its read of the day and the day before, which it reads for the carry-in (`SiteDayReadFacts` on `main`); `not_reported` for a provider that does not count them. A timestamp is unreadable unless it is epoch milliseconds or seconds (a number, or a string of 10 to 13 digits) or an ISO string ending in `Z` or a `±HH:MM` offset, optionally followed by a bracketed zone; a string without a zone is unreadable, not read in the server's zone (openems-provider.ts:227-251).

**Calculated values**

- `meter_window`: the bins searched, inclusive. Start: `firstEveningIndex − 1 − tolerance` to `firstEveningIndex` (site-operations.ts:469-491), `[209, 216]` on a 24-hour day at 5-minute bins. End: from the later of `last − tolerance` and the bin after the meter's own start reading, to `last` (site-operations.ts:494-504); the stored pair is the widest case, `last − tolerance` to `last`.
- `meter_outcomes`: only meters left out of the evening total: `no_start`, `no_end`, `backwards` (end below start, site-operations.ts:507). A meter is counted when its device id is a key in `meter_readings` with no entry in `meter_outcomes`; unreadable meters are in neither.
- Dark ranges by cause, in one item per cause, each with `decidedBy`, an array aligned by index with `ranges`: entry `i` points at the fact that decided range `i` and repeats its value as `v` (a test checks they agree and that the two arrays have the same length):
  - `known_cut`: the gap began with the carried grid state a cut, set by a voltage reading below `gridMinV` in the day or the carry-in; the pointer is that reading.
  - `low_battery`: the gap began with the carried state not a cut (present or unknown) and the last SoC at or below `lowBatPct` (site-operations.ts:403-410); the pointer is that SoC.
  - `after_low_battery`: after a low-battery gap the grid is carried as off until a voltage reading shows it back (site-operations.ts:406-409), so a later gap before then is dark but not inferred. Its pointer is the earlier range, `/items/dark_lowbat/ranges/<j>`, with no `v`.
- `no_data` ranges, with `ruledOut` aligned by index the same way: the last voltage and SoC readings before the gap; a pointer is `null` when there was none yet.
- `summary`: `computeSiteDay`'s figures that a category needs. The item stays `calculated`; a figure resting on an unavailable item (for example `darkMin` when `dark_cut` is `input_unavailable`) is `null` (Z). `darkMin`, `darkInferredMin`, `noDataMin`, `knownMin`, `lightsOnPct` and `cutMin` come from the fields of the same stem; `darkInferredMin` follows the code and excludes `after_low_battery` ranges (site-operations.ts:423, 525). `cutMin` counts every bin whose carried grid state is off, inferred-dark bins and online bins without a voltage reading included (site-operations.ts:520-521, 590). `tenantMetersEveningKwh` is the code's `housesEveningKwh`, and `metersLeftOut` its `housesEveningMetersMissing`, which counts unreadable meters too. Solar and battery-discharge figures are not kept: no category or A2 exit needs them.

**Versions.** `by.calc` is `SITE_DAY_CALC_VERSION` (change 5), bumped by any change to a figure's meaning or threshold; `params` keeps the thresholds. `by.provider` is `openems` or `synthetic`. No release version: nothing at `6cb83bdb` gives the running application one (docs/releasing.md:56-63), and `calc` with `params` suffices.

**A refused read** stores `window` with `date`, `tz`, `zone`, `res` and, on a fallback, `caveat`, but no `t0` or `bins` (a failed result carries neither, capability.ts:712-760; `tz` and `zone` are the operation's when the refusal came before or at the zone read, O2), `units`, `by`, `params`, the sources known before the refusal and one item `{ "c": "unavailable", "k": "read", "reason": …, "from": { "status": …, "code": … } }` under the key `read`; no series.

**Item keys.** This table fixes every item key of `site-day-evidence/1`, its `k`, its kinds and its cause or reason. A key keeps its `k` and cause whatever its kind: when a calculated item's input is unavailable, the item is stored under its own key as `{ "c": "unavailable", "k": …, "cause": …, "reason": "input_unavailable", "in": [<keys of the unavailable items>] }`, with `cause` only on a `dark` item. `summary` is the exception: it stays `calculated`, with `null` figures (Z). A gap's cause is decided when it starts, by the carried grid state first and the last SoC second (site-operations.ts:403-410), so `dark_cut` rests on `src_grid` and the other range items on both `src_grid` and `src_battery`: with `src_grid` unavailable no gap is a known cut, and every gap after a low-battery gap is `after_low_battery`; with `src_battery` unavailable no gap is low-battery. A `meters` item with no device is left out, and so is a range item (`dark_*`, `no_data`) with no range. A range item whose input is unavailable is stored only on a day with a gap (a run of offline bins, §4 `series`), since a day without one has no gap to classify. Every other key is present on a successful read. A refused read holds the `src_*` keys known before the refusal and `read`, nothing else.

| Key | `k` | `c` | Cause or reason | Cited by the finding (§7) |
|---|---|---|---|---|
| `src_battery`, `src_grid`, `src_load`, `src_pv` | `source` (`type` `battery`, `grid_meter`, `inverter` or `pv_meter`, in key order) | `fact`, or `unavailable` | `source_not_readable` or `id_not_storable` when unavailable | `source_unreadable`, when unavailable and limiting (§5) |
| `carry_in` | `carry_in` | `fact` | | none |
| `series` | `series` | `fact` | | none |
| `timestamps` | `timestamps` | `fact`, or `unavailable` | `not_reported` when unavailable | `unreadable_timestamps`, when `dropped` > 0 |
| `dark_cut` | `dark` | `calculated`, or `unavailable` with `in: ["src_grid"]` | cause `known_cut`, kept when unavailable, with reason `input_unavailable` | `dark_known_cut`; `source_unreadable` when unavailable |
| `dark_lowbat` | `dark` | `calculated`, or `unavailable` with `in` naming whichever of `src_grid` and `src_battery` is unavailable | cause `low_battery`, kept when unavailable, with reason `input_unavailable` | `dark_low_battery`; `source_unreadable` when unavailable |
| `dark_after_lowbat` | `dark` | `calculated`, or `unavailable` with `in` as `dark_lowbat` | cause `after_low_battery`, kept when unavailable, with reason `input_unavailable` | `dark_low_battery`; `source_unreadable` when unavailable |
| `no_data` | `no_data` | `calculated`, or `unavailable` with `in` as `dark_lowbat` | reason `input_unavailable` when unavailable | `no_data`; `source_unreadable` when unavailable |
| `meter_window` | `meter_window` | `calculated` | | none |
| `meter_readings` | `meter_readings` | `fact` | | none |
| `meter_outcomes` | `meter_outcomes` | `calculated` | `no_start`, `no_end` or `backwards` per device id | `meter_no_reading` (`no_start`, `no_end`) and `meter_backwards`, per device id |
| `m_unreadable` | `meters` | `unavailable` | `tenant_meter_unreadable` | `meter_unreadable` |
| `m_id_not_storable` | `meters` | `unavailable` | `id_not_storable` | `meter_unreadable` |
| `summary` | `summary` | `calculated`, with `null` figures where an input is unavailable (Z) | | none |
| `read` | `read` | `unavailable` | a §6 reason, with `from` | `unreadable_timestamps` when the reason is `provider_unreadable_timestamps`, else `refusal`; never both |

Both meter causes on one day give both `meters` items, and the `meter_unreadable` finding cites both. A hypothesis may cite any item, or a pointer into one, in `supports` or `against`; "none" above means only that no finding cites the item. The list is closed: the closed-schema test's allowlist (below) holds these keys and no other; E7 checks only the top-level keys in the database. A new key, `k` or dark cause is a new schema version, `site-day-evidence/2`, with this table and the allowlist extended in the same commit, since stored citations point at `@1`'s keys; a marked view that serves the snapshot changes its pinned declaration in the same pull request (ADR-007 decision 8). A new §6 reason is not: reasons are only added (§6).

**Closed schema.** The capability's schema is strict, and a test asserts every key path is on an allowlist (device-id keys and pointers by pattern; `caveat` included). Strings are uuids, the date, IANA zones, closed codes, edge and component ids matching `^[A-Za-z0-9_.:-]{1,64}$` (`OPENEMS_ID_PATTERN`, src/lib/openems/ids.ts, which the database also checks on new rows since 20261124160100; `id_not_storable` then marks a row written before it), and RFC 6901 pointers. No message text. The capture method checks edge and component ids against the pattern before it reads, and treats a device whose id fails it as unreadable: a site source becomes `unavailable` with `id_not_storable`, and a tenant meter is listed in a `meters` item with that reason and left out of the evening total as an unreadable meter is. An id is never stored unchecked.

## 5. The result: `site-day-result/1`

Held in the operation's result (O3). Abridged example for the snapshot above, `<e1>` being its evidence id:

```json
{
  "schema": "site-day-result/1",
  "outcome": "escalation",
  "escalateTo": "field_technician",
  "findings": [
    { "cat": "dark_low_battery", "cites": ["<e1>#/items/dark_lowbat"] },
    { "cat": "dark_known_cut",   "cites": ["<e1>#/items/dark_cut"] },
    { "cat": "no_data",          "cites": ["<e1>#/items/no_data"] },
    { "cat": "meter_backwards",  "cites": ["<e1>#/items/meter_outcomes/<d2>"] },
    { "cat": "meter_no_reading", "cites": ["<e1>#/items/meter_outcomes/<d3>"] },
    { "cat": "meter_unreadable", "cites": ["<e1>#/items/m_unreadable"] }
  ],
  "hypotheses": [
    { "code": "gateway_or_link_down", "finding": 2, "supports": ["<e1>#/items/no_data/ruledOut/0"], "against": [], "confirmBy": "provider_history" },
    { "code": "meter_counter_reset_or_replaced", "finding": 3, "supports": ["<e1>#/items/meter_readings/<d2>"], "against": [], "confirmBy": "field_check" },
    { "code": "meter_comms_loss", "finding": 4, "supports": ["<e1>#/items/meter_readings/<d1>/end"], "against": [], "confirmBy": "field_check" }
  ],
  "unavailable": [ { "cites": ["<e1>#/items/m_unreadable"] } ]
}
```

The snapshot's `src_pv` is unavailable too, but it is neither a finding nor in the result's `unavailable` list: an unreadable solar meter limits no category (§7, outcome rule below). A day whose snapshot holds only a low-battery gap, a solar meter `source_not_readable` and no tenant meter problems is `answered`:

```json
{ "schema": "site-day-result/1", "outcome": "answered", "escalateTo": null,
  "findings": [ { "cat": "dark_low_battery", "cites": ["<e2>#/items/dark_lowbat"] } ],
  "hypotheses": [], "unavailable": [] }
```

- **Closed lists.** `outcome`: `answered`, `evidence_limited`, `escalation`. `escalateTo`: `field_technician`, `ems_vendor`, `mgm_maintainer` or `null` (Q8). `cat`: §7. Hypothesis `code`: `gateway_or_link_down`, `meter_comms_loss`, `meter_counter_reset_or_replaced`, `gap_from_unreadable_timestamps`. `confirmBy`: `field_check`, `ems_vendor`, `provider_history`. No free text.
- **Findings and hypotheses.** A finding covers one category and cites every item or meter in it. A hypothesis explains one finding as a whole; `finding` indexes it. At most one finding per category, and each hypothesis code only on the category §7 gives it, at most once (so at most 9 findings and 4 hypotheses).
- **Citations** are an evidence id plus an RFC 6901 pointer; the result function checks in SQL that each resolves within the operation's evidence before writing the result. A list holds at most 20 citations and a result at most 120. When a category holds more than 20 meters, its finding cites the first 19 in device-id order and the whole `meter_outcomes` item, 20 in all, so every meter stays reachable. The `meter_unreadable` finding cites its one or two `meters` items whole, never per device, so it needs no cap. A citation is at most about 107 bytes as stored (quotes and separator included), so 120 come to about 12.5 KiB; with the top level, nine findings, four hypotheses and the `unavailable` entries, any result within the caps fits 16 KiB; `result_too_large` then marks a defect, not a site too large, so the result function refuses the write and leaves the operation `running` (O3).
- **Contradictory evidence** goes in `against`. Example: `meter_comms_loss` for a meter with no end reading is contradicted when a `no_data` or dark range covers its end window, which points at the gateway instead. A hypothesis with an `against` citation is contested.
- **The result's `unavailable` list** holds only the unavailable items that limit the answer:
  - a refused read's `read` item;
  - a `meters` item (`tenant_meter_unreadable`, `id_not_storable`): the evening total is incomplete;
  - `src_grid` or `src_battery` unavailable, when the day has a gap (§4, item keys), since the cause of a gap rests on them;
  - an `input_unavailable` item that a finding cites.

  Recorded but not limiting: `src_pv` and `src_load` unavailable (they only add to whether a bin is online), `timestamps` `not_reported`, and `src_grid` or `src_battery` on a day with no gap.
- **Outcome.** `escalation` when `escalateTo` names a role (the cases, the next A0 step, set which findings escalate); else `evidence_limited` when the result's `unavailable` list is non-empty, a hypothesis is contested, or `window` has the `zone_fallback` caveat; else `answered`, including a day with no findings.
- **Model text** is A3's to add, marked as the assistant's (`provenance.by: "assistant"` covers only proposed actions today, src/lib/gui/contract.ts:138).

## 6. Reason codes

Codes are snake_case and only ever added, never renamed or reused. Before this document merged, review moved `window_changed` from the snapshot reasons to the operation failure codes, made `result_too_large` a refusal rather than a failure, and dropped the `device_read_unchecked` caveat, which change 4 left nothing to mark; nothing had stored them, and from A2's migration the rule holds without exception. An item from a refusal keeps the capability's status and code in `from` (a code outside the table below is not kept); messages are never stored (untrusted text, #133).

Refusals map by code first, by status only where shown:

| Capability code (status) | `reason` |
|---|---|
| `METERING_UNAUTHORIZED` (any) | `provider_unauthorized`: the metering source, or MGM's stored credential for it, refused the read; not the person (surface/site-day-model.ts:110-112; src/lib/openems/config.ts:133-144) |
| `METERING_CONFIGURATION` (409) | `mixed_edges`, the fixture provider's refusal of a microgrid with synthetic and real edges (fixture/plugin.ts:35-61). This holds only while that is the one source of a 409 with this code: `OPENEMS_NOT_CONFIGURED` is documented as 409 (src/lib/openems/errors.ts:29) and would be passed through with its status (openems-provider.ts:830-842, 849-853), though nothing throws it at `6cb83bdb`. If another `METERING_CONFIGURATION` source comes to return 409, revisit, as `site-day-model.ts:117-119` must too. Change 3 landed without giving the mixed-edges refusal a code of its own: on `main` it is still `METERING_CONFIGURATION` 409 (site-day-model.ts:210-212 on `main`). |
| `METERING_CONFIGURATION` (any other: 503, capability.ts:615-630, openems-provider.ts:559-565, src/lib/openems/client.ts:62-67; 403, openems-provider.ts:762-766; 500 `OPENEMS_INVALID_CONFIG`, src/lib/openems/config.ts:51-68, passed on at openems-provider.ts:849-853) | `provider_not_configured` |
| `metering_site_samples_unsupported` (503; its own code since #264, capability.ts:703-714 on `main`; `METERING_CONFIGURATION` at `6cb83bdb`, capability.ts:633-640) | `provider_unsupported`: the metering source cannot read site samples at all |
| `METERING_UNAVAILABLE` | `provider_unavailable` |
| The majority-unreadable-timestamps refusal's own code, `METERING_UNREADABLE_TIMESTAMPS` since #263 (change 3; openems-provider.ts:598-614 on `main`; `METERING_INVALID_DATA` 502 at `6cb83bdb`, :587-607) | `provider_unreadable_timestamps` |
| `METERING_INVALID_DATA` | `provider_invalid_data`, for example the fixture provider's refusal (fixture-provider.ts:53-61) |
| `metering_no_site_devices` | `no_site_devices` |
| `metering_site_devices_unavailable`, `metering_disabled`, `metering_gate_unavailable` | `site_devices_unavailable`, `metering_disabled`, `gate_unavailable` |
| `metering_timezone_unavailable` (change 4, on `main` since #263) | `zone_unavailable` |
| `metering_invalid_query`, `_microgrid`, `_date`, `_org` | `request_invalid` |
| `metering_site_day_failed` | `calculation_failed` |
| `metering_composition_disposed`, `metering_composition_failed` | `internal_error` |
| `metering_scope_mismatch`, `metering_forbidden`, `metering_unauthenticated` | None: the step ends without evidence and A2 records `access_refused` on the operation |
| Any other | `unknown_refusal`, with `from.status` only; `from.code` is stored only when it is a code in this table |

Not from a refusal: `source_not_readable` (no readable device of a type: none registered, or one without an edge or component id; capability.ts:76-106); `tenant_meter_unreadable` (with device ids); `id_not_storable` (an edge or component id outside the §4 pattern, with device ids); `window_not_closed` (the read ended before the day did, within `INGESTION_LAG_MS` of midnight, site-operations.ts:65, 356-362; stores nothing and is retried, E4); `input_unavailable` (names the unavailable items' keys in `in`, §4); `not_reported`.

Operation failure codes, kept on the operation since no snapshot can hold them (O4): `access_refused`, `evidence_too_large`, `evidence_budget_full` (a capture), `no_successful_read` (E4), `window_changed` (O2), `expired` (§8). The result function's refusals, `result_too_large` and `evidence_budget_full`, are not failures (O3). A refused creation makes no operation and stores nothing; it reports the capability's refusal by these reasons, or, for a date not before today, `window_not_closed` (O2).

## 7. Slice categories

| Category (`cat`) | Representation | Needs (§11) |
|---|---|---|
| Dark after a known cut (`dark_known_cut`) | Dark ranges, cause `known_cut` | change 1 |
| Dark after the battery floor (`dark_low_battery`) | Dark ranges, cause `low_battery` or `after_low_battery` (a gap while the grid is still carried as off after a low-battery gap descends from the battery floor, not from an observed cut; `summary.darkInferredMin` excludes it, as the code does) | change 1 |
| No-data time (`no_data`) | `no_data` ranges with `ruledOut`; hypotheses `gateway_or_link_down` and `gap_from_unreadable_timestamps` (citing `timestamps`) | change 1 (dropped today, site-operations.ts:523) |
| Missing: no reading near start or end (`meter_no_reading`) | A `null` side in `meter_readings`, `meter_window`, outcome `no_start`/`no_end`; hypothesis `meter_comms_loss`, supported by other meters' readings in the same bins, contradicted as in §5 | change 2 |
| Anomalous: counter went backwards (`meter_backwards`) | `meter_readings`, outcome `backwards`; hypothesis `meter_counter_reset_or_replaced` (Q3) | change 2 |
| Anomalous: unreadable timestamps (`unreadable_timestamps`) | At most half unreadable: dropped (refusal needs more than half, openems-provider.ts:591), shown as `timestamps.dropped` > 0, and cited by the `no_data` finding's `gap_from_unreadable_timestamps` hypothesis. More than half: refused, `provider_unreadable_timestamps`; a backend that sends its instants without a zone is refused this way (§4, `timestamps`). | change 3 (required for `@1`) |
| Unavailable: site source (`source_unreadable`) | `source_not_readable` or `id_not_storable` per type; dependents `input_unavailable`. A finding only for a source that limits the answer (§5: `src_grid` or `src_battery` on a day with a gap); any other unreadable source stays in the snapshot, which is where it is reported. A failed device query is refused (`site_devices_unavailable`), not read as no devices. | change 4 |
| Unavailable: tenant meter without identifiers (`meter_unreadable`) | A `meters` item, `tenant_meter_unreadable` or `id_not_storable`, with device ids | change 2 |
| Unavailable: other refusal (`refusal`) | Refused read, §6 reason (`no_site_devices` included), `from`; a `provider_unreadable_timestamps` refusal is `unreadable_timestamps` instead | none |

**Flatlined values** are not a category: #133 limits anomalous readings to backwards counters and unreadable timestamps. A flat series or counter is stored as facts and yields no finding or hypothesis at `@1`; a counter flat over the evening is counted at 0 kWh (Q9).

## 8. Size bound and retention

**Supabase Free plan,** checked 2026-11-18. Supabase's "Database size" docs page: the 500 MB quota is a billing quota for the organization, "summing the database size across all of your projects", averaged daily over the billing period; exceeding it can bring a fair-use restriction (HTTP 402), not read-only mode; the fixed 2 GB disk goes read-only at 95%. The pricing page says "500 MB database size per project included". This design takes the stricter, per-organization reading. Re-check both before A2's migration fixes the budget (Q1). #30 keeps free hosting.

**Measurement.** KiB and MiB are binary; Supabase's MB is 10⁶ bytes. A size is the byte length of the stored `jsonb::text` (with `", "` and `": "` separators). The write function computes it from the stored value; the caller never supplies it. Postgres prints numbers differently from `JSON.stringify`: an exponent form such as `2.2737367544323206e-13` or `1e21` becomes a full decimal in jsonb, so a size estimated in TypeScript can be lower than the database's. The capture may estimate first, but the database's count decides: over 128 KiB the capture function stores nothing, commits the operation's failure with `evidence_too_large` and returns that code, which the step reports (O4). It does not raise, which would roll the failure back, and the code is not a generic CHECK violation. A2's test includes exponent-form values.

**Proposed** (Q1): snapshot at most 128 KiB, result 16 KiB, three snapshots per operation. Evidence gets 50 MB (47.7 MiB), 10% of the quota: at most 40 MiB counted bytes (snapshots and results of retained operations), 7.7 MiB for row, index and TOAST overhead and unreused space. Compression is unmeasured and jsonb stores numbers as `numeric`, so A2 compares `pg_total_relation_size` with counted bytes on a synthetic full budget before 40 MiB is ratified.

**Sizes,** from generated snapshots of §4's shape, 24-hour day (a 25-hour day adds about 4% to the series); this revision's changes to the shape (`window.zone`, `decidedBy` arrays, fewer summary figures) change them by well under 0.1 KiB. Low: rounded as the fixture rounds (fixture/site-samples.ts:214-225), no solar series. High: every value a 16–17 digit float, with a solar series and no empty bins. Everything but tenant meters: 10.9 KiB low, 35.3 KiB high (the §4 example's 61 empty bins would give about 30.6 KiB). Per tenant meter: about 116–135 B counted; left out, 147 B (`no_start`), 155–165 B (`no_end`) or 169–188 B (`backwards`); 40 B unreadable. A refused read with three known sources: about 1.1 KiB.

| Site | Snapshot, low – high | Operations in 40 MiB (2 KiB result) |
|---|---|---|
| 10 tenant meters, 2 left out | 12.2 – 36.7 KiB | about 2,880 – 1,060 |
| 50 tenant meters, 5 left out | 16.8 – 42.1 KiB | about 2,180 – 930 |
| 500 tenant meters, 20 left out | 68.8 – 101.9 KiB | about 580 – 390 |

- A typical result is about 2 KiB; the 16 KiB worst case is in the per-operation figure below.
- The local development seed's ten consumption meters (00003_seed.sql.template:10-14) allow, in the high case, about 11 investigations a day for 90 days. The pilot's counts are not public; pilot import's 500-tenant cap (docs/pilot-import.md:18) is per run, not a site size.
- Worst case per operation (128 KiB read, two refused reads of about 1.1 KiB, 16 KiB result): about 146 KiB, so about 280 operations.
- **Meter threshold** (Q4): 128 KiB is reached at about 505 tenant meters (high, all left out as `backwards`), 700 (high, all counted), 710 (low, all `backwards`) or 1,030 (low, all counted), on a 24-hour day. A 25-hour day's longer series (about 1.5 KiB more in the high case) lower the first figure to about 495, so up to about 490 fits on the measured shapes. A day of many short gaps adds up to about 8 KiB of ranges (`ruledOut` and `decidedBy` entries included), so about 450 always fits. Beyond, the operation fails with `evidence_too_large`; nothing is truncated, since that would remove the facts outcomes rest on.

**Budget.** A capture that would take counted bytes over 40 MiB fails the operation with `evidence_budget_full`, as an oversized capture does; a result that would is refused with that code and leaves the operation `running` (O3); concurrent writers cannot together pass it. The count uses stored sizes, not relation size, which does not reliably shrink after deletes. The check sees every organization's sizes and reveals none of them. One budget lets one organization's investigations refuse another's, and the refusal itself tells an operator that others' evidence fills the shared allowance (Q5).

**Retention**

- An operation and its evidence are eligible for deletion 90 days after the operation ended (completed, failed or cancelled) (Q2): a billing month, its review and a follow-up. OpenEMS stays the source of record for raw data.
- An operation still `running` 90 days after it was created (its only state change while running, O4) is first ended: the retention pass marks it `failed` with `expired`, recorded like any other state change but with no actor, since the pass acts for no person and may run from another organization's session, and it becomes eligible 90 days after that. It is never deleted while open.
- The `@1` mechanism is delete on write, as `auth_sign_in_requests` does (20261117030000_auth_sign_in_requests.sql:11-12, 55-71): the pass runs in the operator's session when the next operation is created, needs no job at cutover, and makes 90 days a minimum, not a maximum. A scheduled job would be the first background job in the operations capability and conflicts with A2's "no background worker, queue, or delegated identity" (#133); if tenant meter readings need a hard maximum, that waits for the separate review of unattended work (Q6).
- A pass deletes at most 200 rows, so no caller pays for a backlog (ADR-007 decision 3). It deletes an operation only with all its evidence, one to four rows (the operation and up to three records). It deletes eligible operations oldest end time first, until the next would take it over 200 rows, so it deletes at least 50 operations when that many are eligible. An operation holds at most one successful read, so 200 rows hold at most about 14 MiB: 100 operations of one 128 KiB read and a 16 KiB result. It also ends at most 50 expired `running` operations, oldest creation time first, each a one-row update, on top of the 200 deleted rows. A backlog over these bounds is cleared over several creations, so the 90-day times above and in O4 are when a row becomes eligible, a minimum, not when it is ended or deleted. A2's retention test pins the 200-row cap, the 50-operation minimum and the 50 expired operations.
- A restore rehearsal in the same Supabase organization adds the whole restored database to the daily average while it exists. If that could pass 500 MB averaged, keep it brief or outside the organization.

## 9. Export, restore and deletion

Tables in `public` go into `data.sql` (scripts/backup/export-database.sh:628, 652-657) and the row-count check (backup-and-restore.md:897-919). No Storage bucket, Vault secret or scheduled job.

A2's runbook text (A2 exit; coordinate with #50, which owns export coverage under #30's M4 bullet) must cover:

1. **Recovery inputs** (:20-35): operations and evidence are exported: site telemetry, tenant meter readings by device id, staff user ids as capturers, no tenant names or contact details; confidential like the rest (:49-55). Old export files keep rows past retention; the operator decides their life.
2. **The load.** Triggers do not run in the replica-mode load (:536-545). Verification confirms each stored size matches its content and counted bytes are within budget.
3. **Investigations open or finished after the export,** like "Billing periods closed after the export" (:746-779): an operation comes back in its state at `data_dump_started_utc`, so one that ended after it is `running` again, without the records and result written after it. An authorised person continues or cancels each `running` operation (O4), never editing by SQL; operations created after `data_dump_started_utc` are missing and rerun if needed.
4. **Expired rows** from an old export are removed by the retention passes of the next creations, within the per-pass bound (§8), rehearsals included.

**Deletion.** Deleting a microgrid cascades to its operations and evidence; a community or organization cascades through `communities → microgrids` (00001_schema.sql:82, 99). Referential actions run as the table owner, so the invoker `fn_entity_delete_*` functions (20260926130210:76-115) need no delete permission on evidence, as they need none on `billing_periods`, whose DELETE is revoked from `authenticated` (20261120130000:63-68); A2's test confirms it. Evidence adds no delete guard; billing's keep-guards still refuse parent deletion on their own grounds (20261103160000:102-340) (Q7). Deleting a device changes no evidence; deleting a user nulls the capturer (E5).

## 10. Access and the model data boundary

**Access requirements**

- Reading, as ADR-007 decision 3 sets it: one `FOR SELECT` policy per table `TO authenticated, mgm_agent`, calling `user_can_access_microgrid` with the row's microgrid id; no helper body changes. `authenticated` is granted SELECT; `mgm_agent` is granted SELECT by column, without the capturer column or any other staff user id, such as an operation's actor references (O3), and EXECUTE on `user_can_access_microgrid`. If `mgm_agent` is not built, the policies are `TO authenticated` alone. No table joins the `supabase_realtime` publication until what `mgm_agent` may receive from it is decided (#268). Tenants get no read path (the helper grants nothing for tenant rows); `anon` gets nothing.
- Writing only through the write functions (E1). The tables have no INSERT, UPDATE or DELETE policy, and the migration revokes INSERT, UPDATE and DELETE from `authenticated` and `service_role`, which new tables otherwise keep by default (20261114222000:102-106). ADR-007 decision 3 names only `authenticated`; `service_role` bypasses row-level security, so its revoke is what makes "no API role writes those tables directly" hold, and nothing through A3 writes on the service role (#133). A test pins the privileges, as `delete_draft_billing_period.test.ts` does for the DELETE revoked on `billing_periods` (20261120130000:70-74, 124), since a later blanket grant would give them back.
- The operations capability plugin calls `requireOrganizationAudience` first in `apply` (src/lib/runtime/services.ts:61; metering does at compose.ts:59), as every capability plugin that trusts `organizationId` or `roles` must, so it never loads into a tenant-app request.
- Revoked access and a disabled operations plugin stop further steps, and because the write functions check both in SQL (E1), this holds for a direct call over PostgREST as well as for one through MGM's server. Stored evidence stays readable while the plugin is off (#133). A2 decides the TypeScript gating (the gate's `microgrid` target, src/lib/runtime/gate.ts:30-40, may serve).
- **Policy shape.** CLAUDE.md names only the tenant policies as exceptions to `FOR ALL`. These tables have another shape: read-only to the API roles, with a `FOR SELECT` policy alone, written only by definer functions. The nearest precedents are partial: `billing_periods` keeps its `FOR ALL` policy but has DELETE revoked, with a definer function as the only delete (20261120130000:83-124), and `staff_access_accounts` has row-level security, no policy and no API grants (20261118140000:251-252). ADR-007 decision 3 names the shape; CLAUDE.md names it, and its policy counts change, with the migration.
- **Tests,** in one commit with the migration and regenerated types, cover:
  - RLS and grants, refusal of a tenant and of another organization's manager, no capturer column or other staff user id for `mgm_agent`, no INSERT, UPDATE or DELETE for `authenticated` or `service_role`, and no EXECUTE on the write functions for `service_role` unless A2 keeps it (E8);
  - E1–E5: a direct table insert refused; a direct call of the capture function with fabricated content while the plugin is disabled refused; the same call with the plugin enabled accepted and attributed to the caller (the §2 position); a supplied microgrid id that differs from the operation's refused; a retry with the same attempt key returning the stored record; deleting a user who captured evidence succeeds;
  - the size count with exponent-form values, the budget, retention (an open operation expired, not deleted), and the cascade.

**Model data boundary** (decided in ADR-007; this is a pointer)

- This slice needs per-meter readings that no current view carries: `metering.site-day` emits no device ids or per-meter values, and merges refusal codes (surface/site-day-model.ts:112-131; surface/site-day.ts:40-47). The views and signals added since do not change that: the tenant usage views show a unit's own meter energy per day and hour to that unit's tenant only, carry no counter readings, and no staff assistant can read them: at `6cb83bdb` registration refuses the mark on a tenant view (src/lib/gui/host/server/contribution-schema.ts:262-266), and under ADR-007 decision 10 only that tenant's own agent client may read them; the `metering.connection` signal reports a microgrid's last stored OpenEMS connection check, not the day's telemetry (surface/connection-signals.ts). No view is marked `agent: "read"` at `6cb83bdb`. Under #133's invariant ("revisit it if an investigation needs data no view carries"), this is the revisit case. ADR-007 decision 9 settles it: the operations plugin contributes one stored evidence view per investigation, at `/microgrids/[microgridId]/investigations/[operationId]`, marked `agent: "read"` in the pull request that builds it (A3's), serving the stored snapshot and result, never a live read. Until it is built and marked, evidence reaches no model.
- Content from #133's boundary list: readings and values from them, device types, microgrid and device ids, OpenEMS edge and component ids. Content not on that list, which ADR-007 decision 6 admits for this view: the date, the IANA zone, the ids of the operation and of its evidence records, and the closed codes and keys of this document, citations included; §4's closed string allowlist is the binding form. Edge and component ids come from the database or a vendor; the §4 pattern limits their shape, not their meaning, so they stay untrusted text in model context (#133), and an id failing the pattern is never stored (§4).
- Never `devices.name`, tenant ids, names, contact or payment data, `address_country`, the EMS URL or user name, staff user ids (the capturer column and an operation's actor references are not granted to `mgm_agent`), or message text.
- The time-zone notice, which carries the free-text country, is not part of the evidence and is withheld from an assistant (ADR-007 decision 8). Q10 is settled.

## 11. Metering changes this depends on

Changes 1, 3 and 4 are on `main` (3 and 4 since #263) and are kept here as the record of what `@1` relies on; the others are changes, not current behaviour. All are in `src/lib/metering/`, which `.github/CODEOWNERS` does not list at `6cb83bdb`, so none is code-owned.

1. (On `main`, as `computeSiteDayDetail` in site-operations.ts, which returns them beside the unchanged day, keyed as §4's items, each deciding reading as a series, bin position and value, with the carry-in readings and their positions; the capture method maps positions to pointers.) Return no-data ranges (computed, then dropped, site-operations.ts:523) and dark ranges by cause with deciding samples.
2. Return each readable linked tenant meter's readings and outcome by device id and component id (the loop's `Object.values` loses the keys, site-operations.ts:465), and the unreadable meters' ids (only counted today, capability.ts:94-104). `getDeviceEnergySeries`, added for the tenant usage views (types.ts:35-41, 68-79), does not provide this: it returns each meter's energy summed per hour or day, null for any missing hour, not the counter readings at the window's bins that `meter_readings` holds, and `getSiteDay` does not read it.
3. (On `main` since #263.) Report the count of dropped unreadable timestamps and give the majority refusal its own code. Required for `@1`: without it the majority case is indistinguishable from other invalid-data refusals and the minority case is invisible. Its optional parts did not land: `fromMeteringError` still turns 502 into 503 (capability.ts:214-225; 216-227 on `main`), and the mixed-edges refusal keeps `METERING_CONFIGURATION` 409 (§6). The tenant usage read still refuses a majority of unreadable timestamps as `METERING_INVALID_DATA` 502 (openems-provider.ts:445-465; 459-463 on `main`); `@1` needed the new code only on the site read.
4. (On `main` since #263, as `metering_site_devices_unavailable` and `metering_timezone_unavailable`.) Make `getManagedDevices` throw on a query error; at `6cb83bdb` it ignores both queries' errors and returns `[]`, so a failed read reports `metering_no_site_devices` (infrastructure/supabase-repository.ts:153-181). Likewise make `getMicrogridTimezone` throw, so that a failed zone read is refused rather than becoming the UTC fallback (:145-150), and have `openSiteQuery` report when it fell back to UTC.
5. Add the capture method beside `getSiteDay`, and `SITE_DAY_CALC_VERSION`. Beyond `SiteDayRead` (`SiteDayOperations`, which carries SoC and flows (battery, grid and a computed solar figure), plus the `read` facts #263 added: the fallback flag and the dropped-timestamp count; site-operations.ts:244-263 and capability.ts:823-830 on `main`), the method returns: the six series per bin as picked (§4), the carry-in values with their positions, the source device, edge and component ids per type (today `reader.sources` stays inside the capability, capability.ts:661-685), the IANA zone it used, with the fallback flag, on a refusal too, and whether the read ended before the day. It applies `OPENEMS_ID_PATTERN` (§4) before reading. Add a test that fails until `SITE_DAY_CALC_VERSION` is bumped for a changed figure.
6. Add fixture scenarios: a silent tenant meter near 18:00 or the end, an evening counter reset, a site-wide gap at the window's edge, unreadable timestamps, a provider outage, an unreadable linked meter. Cumulative weights pick scenarios (fixture/site-samples.ts:21-27, 69-74), so a new one changes pinned dates whose draw falls in a moved range; use a separate hash, or re-seed and re-pin. The hash and generator now live in fixture/random.ts, shared with fixture/meter-energy.ts, which generates per-meter hourly energy for `getDeviceEnergySeries` under its own seed, including blocks of hours a meter did not report. That is not a site-day scenario: `getSiteDay` does not read it, and its figures do not reconcile with the site samples (meter-energy.ts:10-14), so none of the scenarios above exists yet.

Code-owned work is A2's and A3's: the migration, plugin registration (`/src/lib/plugins/` and a migration that adds the name to the plugin-name CHECKs and `fn_mgm_set_plugin_enabled`, whose latest definition and newest precedent is `20261118140000_tenant_app_plugin.sql`, after `00065_payments_capability.sql`; if the plugin is off by default, `defaultEnabled: false` in bundled.ts and the name in `mgm_plugin_enabled_for_org`'s list, in one commit, which `default-off-plugins.test.ts` checks), `REQUEST_SERVICES` (`/src/lib/runtime/`), any page's entry in `/src/lib/mgm/released-routes.ts`, and any marked view (`/src/lib/gui/`, `/src/app/api/gui/`).

## 12. Deferred

A2 builds the records, plugin, routes, migration, tests and runbook text; A3 the agent sessions, model text and any evidence view. Multi-day windows, raw sample storage, legal holds, unattended work (a scheduled retention job included), server-held attestation of facts, and A5/A6 records wait for a first consumer.

## 13. Open questions

| # | Question | Proposal | Decision owner |
|---|---|---|---|
| Q1 | Is 50 MB safe beside production's size and a rehearsal? | Get production's size privately from the operator; lower the allowance if it is above about 350 MB. tushabe read production's size on 25 November 2026 and is sending it privately. | The A0 owner |
| Q2 | Retention period | Eligible for deletion 90 days after the operation ended; an operation open for 90 days is first ended as `expired`. | The A0 owner; reviewer arindahills |
| Q3 | "Went backwards": lower net reading, or any backward step? | Lower net reading, as the code (site-operations.ts:507) and its test (site-operations.test.ts:968) do. | The A0 owner; arindahills as operator evaluator |
| Q4 | Sites over 128 KiB (from about 495 tenant meters on the measured shapes, about 450 on a day of many short gaps; up to about 450 always fits, §8) | Fail with `evidence_too_large` at `@1`; revisit with real counts. | The A0 owner |
| Q5 | Is one installation-wide budget fair across organizations? | Accept while one organization runs investigations; add per-organization shares when a second enables the plugin. The trade-off includes that `evidence_budget_full` tells an operator in one organization that others' evidence fills the shared allowance, a small signal about another organization's activity, though no sizes are revealed. | The A0 owner; reviewer arindahills |
| Q6 | Retention mechanism | Delete on write at `@1` (90 days a minimum). A scheduled job would be the first background job in the operations capability and conflicts with A2's "no background worker"; a hard maximum for tenant meter readings waits for the separate review of unattended work. tushabe answered as proposed on 25 November 2026; arindahills's confirmation is pending. | Code owners tushabe and arindahills |
| Q7 | Cascade evidence on microgrid deletion, or refuse it as billing does? | Cascade, verified by A2's test. tushabe answered as proposed on 25 November 2026; arindahills's confirmation is pending. | Code owners tushabe and arindahills |
| Q8 | Escalation roles | `field_technician`, `ems_vendor`, `mgm_maintainer`. | The A0 owner; arindahills as operator evaluator |
| Q9 | Flatlined values: a no-finding case, or dropped from the cases? | Keep one no-finding case. | The A0 owner; reviewer arindahills |
| Q10 | ADR-007: mark an evidence view, and at what scope (views take organization or installation scope plus path segments, or tenant scope, which no staff assistant may read, src/lib/gui/host/server/contribution-schema.ts:251, 262-266; the gate has no operation target, src/lib/runtime/gate.ts:30-40)? Is `timezoneNotice`, carrying the free-text country (src/lib/timezone/nudge.ts:25-26), served to an assistant? | Settled by ADR-007 decisions 8 and 9: one stored evidence view per investigation at `/microgrids/[microgridId]/investigations/[operationId]`, resolved through the operations plugin's own entity kind, so the gate needs no new target; the notice is withheld (§10). | Reviewer arindahills; code owners tushabe and arindahills |

