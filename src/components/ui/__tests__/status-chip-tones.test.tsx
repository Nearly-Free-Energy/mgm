// Pins the Chip tone and dot of every status in STATUS_MAPS, so an edit to a
// tone there shows up here as well as in every GUI that fmt.status serves.
// Each entry is "status=chipTone", with "*" when the chip shows a dot.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusChip } from "../status-chip";
import { STATUS_MAPS, type StatusKind } from "@/lib/gui/status-maps";

const EXPECTED: Record<StatusKind, string> = {
  billingLineItemPaymentStatus: "unpaid=neutral link_generated=warn* paid=success* failed=alert* refunded=neutral",
  billingLineItemReadingSource: "edge=success manual=neutral",
  billingPeriod: "draft=warn* closed=success*",
  edge: "online=success* degraded=warn* offline=alert* stale=success* unknown=neutral*",
  edgeSource: "openems=brand modbus_direct=neutral mqtt=neutral rest_api=neutral",
  household: "active=success* inactive=neutral* disputed=alert*",
  householdCustomerType: "residential=neutral commercial=brand",
  deviceType:
    "consumption_meter=warn grid_meter=brand pv_meter=success battery=success inverter=brand ev_charger=brand other=neutral",
  householdDeviceRole:
    "primary_consumption_meter=warn secondary_meter=neutral battery=success solar=success ev_charger=brand other=neutral",
  meter: "linked=success* not_configured=warn*",
  meterType:
    "grid=brand consumption=warn production=success unknown=neutral GRID=brand CONSUMPTION=warn PRODUCTION=success UNKNOWN=neutral",
  openemsBackendHealth: "healthy=success* failing=alert* not_configured=neutral",
  siteDay: "cut=warn floor=warn dark=alert",
};

const CHIP_BG: Record<string, string> = {
  neutral: "bg-muted",
  success: "bg-success-muted",
  warn: "bg-warning-muted",
  alert: "bg-destructive-muted",
  brand: "bg-accent",
};

const ROWS = Object.entries(EXPECTED).flatMap(([kind, list]) =>
  list.split(" ").map((entry) => {
    // A trailing "*" marks a status whose chip shows a dot.
    const dot = entry.endsWith("*");
    const [status, tone] = (dot ? entry.slice(0, -1) : entry).split("=");
    return [kind as StatusKind, status, tone, dot] as const;
  }),
);

describe("StatusChip tones for every status in STATUS_MAPS", () => {
  it("lists exactly the statuses in STATUS_MAPS", () => {
    const actual = Object.entries(STATUS_MAPS).flatMap(([kind, map]) => Object.keys(map).map((s) => `${kind}.${s}`));
    expect(ROWS.map(([kind, status]) => `${kind}.${status}`).sort()).toEqual(actual.sort());
  });

  it.each(ROWS)("%s %s renders the %s tone, dot %s", (kind, status, tone, dot) => {
    const { container } = render(<StatusChip kind={kind} status={status} />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.classList.contains(CHIP_BG[tone])).toBe(true);
    expect(chip.querySelector('[aria-hidden="true"]') !== null).toBe(dot);
  });
});
