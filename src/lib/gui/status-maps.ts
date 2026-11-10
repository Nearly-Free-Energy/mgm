// Status maps — every domain status a chip or a GUI Value shows, with its
// label and tone, in ONE PLACE. <StatusChip> renders these, and the server's
// fmt.status serves them to GUIs. When the schema's status set evolves, only
// this file changes. Add new domain enums here, not inline.
//
// Plain data, safe to load in a browser: its only import is a type.

import type { Tone } from "./contract";

export type StatusEntry = { label: string; tone: Tone; dot?: boolean };

export const STATUS_MAPS = {
  // Billing line item payment status — maps the billing_line_item_payment_status
  // enum (migrations 00021 + 00027/00028) to tones for the manual mark-paid +
  // IPN Phase B UI (#124, #157).
  //
  // Tone rationale (per Designer §3 evaluation lens, existing token set):
  //   unpaid          → neutral  (resting state — no action taken yet)
  //   link_generated  → warning  (link out, awaiting payment — pending state)
  //   paid            → success  (money received — positive outcome)
  //   failed          → danger   (payment failed — attention required; dot marker)
  //   refunded        → neutral  (terminal, informational)
  billingLineItemPaymentStatus: {
    unpaid:         { label: "Unpaid",         tone: "neutral"                   },
    link_generated: { label: "Link sent",      tone: "warning", dot: true        },
    paid:           { label: "Paid",           tone: "success", dot: true        },
    failed:         { label: "Failed",         tone: "danger",  dot: true        },
    refunded:       { label: "Refunded",       tone: "neutral"                   },
  },
  // BC2 (#174) — billing_line_items.reading_source provenance chip.
  // Display-only: indicates whether a row's kWh values came from the edge
  // device feed (auto-generated) or from operator manual entry. Tones:
  //   edge   → success (the auto path "just works" — positive default)
  //   manual → neutral (Chip has no `info` tone — neutral is the resting
  //                     indicator for human-entered data; the entered-by
  //                     caption beneath communicates "who").
  billingLineItemReadingSource: {
    edge:   { label: "Edge",   tone: "success" },
    manual: { label: "Manual", tone: "neutral" },
  },
  billingPeriod: {
    draft:  { label: "Draft",  tone: "warning", dot: true },
    closed: { label: "Closed", tone: "success", dot: true },
  },
  edge: {
    online:   { label: "Online",   tone: "success", dot: true },
    degraded: { label: "Degraded", tone: "warning", dot: true },
    offline:  { label: "Offline",  tone: "danger",  dot: true },
    stale:    { label: "Stale",    tone: "success", dot: true }, // pair with state="stale"
    unknown:  { label: "Unknown",  tone: "neutral", dot: true },
  },
  // Edge data-source classification — mirrors `edge_data_source` enum in AB #50.
  // Tones: accent for the default (openems); neutral for the non-OpenEMS hedge
  // sources (modbus_direct, mqtt, rest_api). No dot — this is a type label,
  // not a connectivity state.
  edgeSource: {
    openems:       { label: "OpenEMS",       tone: "accent" },
    modbus_direct: { label: "Modbus direct", tone: "neutral" },
    mqtt:          { label: "MQTT",          tone: "neutral" },
    rest_api:      { label: "REST API",      tone: "neutral" },
  },
  household: {
    active:   { label: "Active",   tone: "success", dot: true },
    inactive: { label: "Inactive", tone: "neutral", dot: true },
    disputed: { label: "Disputed", tone: "danger",  dot: true },
  },
  // PDF3 (#205) — household customer-type chip surfaced inside the
  // HouseholdTable's Household cell. Mirrors the `customer_type` column
  // (residential | commercial; PDF1a / 00033). `neutral` (resting; the
  // majority class) and `accent` (visually distinct; commercial) carry the
  // contrast.
  householdCustomerType: {
    residential: { label: "Residential", tone: "neutral" },
    commercial:  { label: "Commercial",  tone: "accent"  },
  },
  // Canonical device-type chip — mirrors `device_type` enum in AB #50.
  // Tone rationale (per mock mgm-ia-v1.html § IA note line 1794):
  //   consumption_meter → warning (billable — draws Aaron's attention)
  //   grid_meter        → accent (the microgrid-level import/export feed)
  //   pv_meter          → success (generation)
  //   battery           → success (storage, charging tone)
  //   inverter          → accent (power conversion equipment)
  //   ev_charger        → accent (controllable load)
  //   other             → neutral (catchall)
  deviceType: {
    consumption_meter: { label: "Consumption meter", tone: "warning" },
    grid_meter:        { label: "Grid meter",        tone: "accent" },
    pv_meter:          { label: "PV meter",          tone: "success" },
    battery:           { label: "Battery",           tone: "success" },
    inverter:          { label: "Inverter",          tone: "accent" },
    ev_charger:        { label: "EV charger",        tone: "accent" },
    other:             { label: "Other",             tone: "neutral" },
  },
  // Household device role — mirrors `household_device_role` enum in AB schema.
  // Tone rationale:
  //   primary_consumption_meter → warning (the billable metering device; draws attention)
  //   secondary_meter           → neutral (supplementary measurement, non-primary)
  //   battery                   → success (storage asset)
  //   solar                     → success (generation asset)
  //   ev_charger                → accent (controllable load)
  //   other                     → neutral (catchall)
  householdDeviceRole: {
    primary_consumption_meter: { label: "Primary meter", tone: "warning" },
    secondary_meter:           { label: "Secondary meter", tone: "neutral" },
    battery:                   { label: "Battery",         tone: "success" },
    solar:                     { label: "Solar",           tone: "success" },
    ev_charger:                { label: "EV charger",      tone: "accent" },
    other:                     { label: "Other",           tone: "neutral" },
  },
  // #158: per-household meter assignment status. The HouseholdTable cell
  // surfaces this so an entrepreneur can tell at a glance which households
  // require a manual usage entry each period vs. the metered/automated flow.
  //
  // Tone rationale:
  //   linked          → success (the OpenEMS reading flow is wired)
  //   not_configured  → warning (manual billing is an active state, not an
  //                     error — but it does need attention each period)
  meter: {
    linked:         { label: "Meter linked",   tone: "success", dot: true },
    not_configured: { label: "No meter",       tone: "warning", dot: true },
  },
  meterType: {
    // Lowercase keys (original)
    grid:        { label: "Grid",        tone: "accent" },
    consumption: { label: "Consumption", tone: "warning" },
    production:  { label: "Production",  tone: "success" },
    unknown:     { label: "Unknown",     tone: "neutral" },
    // Uppercase keys — openems types.ts:75 emits uppercase meter_type
    GRID:        { label: "Grid",        tone: "accent" },
    CONSUMPTION: { label: "Consumption", tone: "warning" },
    PRODUCTION:  { label: "Production",  tone: "success" },
    UNKNOWN:     { label: "Unknown",     tone: "neutral" },
  },
  // OpenEMS Backend per-microgrid health (#102, #215).
  //   healthy       — fail-open: ems_type set with no negative discover signal
  //                   (covers `success` at any age and any unrecognized/null status).
  //   failing       — last Discover ended in auth_failed / unreachable /
  //                   zero_edges / unknown_error.
  //   not_configured — ems_type IS NULL; no Discover has run. NO dot (chip
  //                   shouldn't imply any state, just absence).
  openemsBackendHealth: {
    healthy:        { label: "Healthy",       tone: "success", dot: true  },
    failing:        { label: "Failing",       tone: "danger",  dot: true  },
    not_configured: { label: "Not connected", tone: "neutral" /* no dot */ },
  },
  // Operations day tile statuses: a grid cut, the battery at its discharge
  // floor, houses without power.
  siteDay: {
    cut:   { label: "Grid cuts",    tone: "warning" },
    floor: { label: "At the floor", tone: "warning" },
    dark:  { label: "Houses dark",  tone: "danger"  },
  },
} as const satisfies Record<string, Record<string, StatusEntry>>;

export type StatusKind = keyof typeof STATUS_MAPS;

/** The entry for `status` in map `kind`, or undefined when either is unknown. */
export function statusEntry(kind: StatusKind, status: string): StatusEntry | undefined {
  if (!Object.hasOwn(STATUS_MAPS, kind)) return undefined;
  const map: Readonly<Record<string, StatusEntry>> = STATUS_MAPS[kind];
  return Object.hasOwn(map, status) ? map[status] : undefined;
}
