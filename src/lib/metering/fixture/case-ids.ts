/**
 * case-ids.ts — the pinned identifiers of #133's investigation cases
 * (docs/investigation-cases.md §1): the two organizations, their
 * communities, the case microgrids, their edges and their devices.
 *
 * Pure: no clock, no I/O, no server-only import, so the fixture generator
 * may read it as well as the tests. The generator keys a day on the
 * microgrid's UUID and a house meter on the device's UUID
 * (site-samples.ts), so these values are what make a case reproduce; a
 * changed id is a changed case. docs/investigation-cases.md §1 states the
 * same values; if either changes, change both.
 */
import type { DeviceType } from "@/lib/types/domain";

const UUID_PREFIX = "00000000-0000-4000-8000-";

/** Organization A: every case microgrid but 0a. */
export const CASE_ORG_A = `${UUID_PREFIX}0000000c00a0`;
/** Organization B, where metering is off: microgrid 0a, for C14. */
export const CASE_ORG_B = `${UUID_PREFIX}0000000c00b0`;
/** One community per organization. */
export const CASE_COMMUNITY_A = `${UUID_PREFIX}0000000c00a1`;
export const CASE_COMMUNITY_B = `${UUID_PREFIX}0000000c00b1`;

/** Two lowercase hexadecimal digits, 01 to 14 (1 to 20). */
const CASE_NUMBER_RE = /^[0-9a-f]{2}$/;
const DEVICE_NUMBER_RE = /^\d{2}$/;

function caseNumber(nn: string): number {
  const value = CASE_NUMBER_RE.test(nn) ? parseInt(nn, 16) : NaN;
  if (!(value >= 1 && value <= 0x14)) {
    throw new RangeError(`A case microgrid is 01 to 14 in hexadecimal, not "${nn}"`);
  }
  return value;
}

/** Microgrid *nn* (hexadecimal, 01 to 14): `…0000000c00nn`. */
export function caseMicrogridId(nn: string): string {
  caseNumber(nn);
  return `${UUID_PREFIX}0000000c00${nn}`;
}

/** Device *dd* of microgrid *nn*: `…0000000cnndd`. */
export function caseDeviceId(nn: string, dd: string): string {
  caseNumber(nn);
  if (!DEVICE_NUMBER_RE.test(dd)) throw new RangeError(`A case device is two digits, not "${dd}"`);
  return `${UUID_PREFIX}0000000c${nn}${dd}`;
}

/**
 * The synthetic edge of microgrid *nn*: its number in decimal, two digits
 * (microgrid 0a's edge is `SYNTHETIC-EDGE-CASE-10`). The prefix is the
 * fixture provider's reserved one (`SYNTHETIC_EDGE_ID_PREFIX`), so the
 * synthetic provider serves these microgrids.
 */
export function caseEdgeId(nn: string): string {
  return `SYNTHETIC-EDGE-CASE-${String(caseNumber(nn)).padStart(2, "0")}`;
}

export type CaseDevice = {
  /** Two digits: the device's number in `caseDeviceId`. */
  dd: string;
  type: DeviceType;
  componentId: string;
  /** Linked to a unit as its primary consumption meter from 2026-01-01, open-ended. */
  tenantLinked: boolean;
};

/** The full device set every case microgrid starts from (§1 "Devices"). */
export const CASE_DEVICES: readonly CaseDevice[] = [
  { dd: "01", type: "battery", componentId: "ess0", tenantLinked: false },
  { dd: "02", type: "grid_meter", componentId: "meter0", tenantLinked: false },
  { dd: "03", type: "inverter", componentId: "inverter0", tenantLinked: false },
  { dd: "04", type: "pv_meter", componentId: "meter4", tenantLinked: false },
  { dd: "11", type: "consumption_meter", componentId: "meter1", tenantLinked: true },
  { dd: "12", type: "consumption_meter", componentId: "meter2", tenantLinked: true },
  { dd: "13", type: "consumption_meter", componentId: "meter3", tenantLinked: true },
];
