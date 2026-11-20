import "server-only";

/**
 * The signals of the `metering.connection` watcher (./connection-signals.ts):
 * one per microgrid whose last OpenEMS connection check failed, leading to
 * its OpenEMS Backend page.
 *
 * What a signal reports is the last check's result
 * (microgrids.ems_last_discover_status), which changes only when someone
 * runs Discover, tests the connection or saves the backend; it is not the
 * backend's state now. The copy says what that check found, and the fact
 * when. If something starts writing those columns on a schedule, the copy
 * may speak of the connection itself; revisit then.
 *
 * Fixed copy: the microgrid's name and a sentence per status, never the
 * stored error text, which comes from the vendor.
 */
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { isFailingDiscoverStatus, type FailingDiscoverStatus } from "../backend-health";

export const CONNECTION_SIGNAL = "metering.connection";

export const CONNECTION_COPY: Readonly<Record<FailingDiscoverStatus, string>> = {
  auth_failed: "OpenEMS refused the saved sign-in",
  unreachable: "OpenEMS could not be reached",
  zero_edges: "OpenEMS lists no edges",
  unknown_error: "the OpenEMS connection check failed",
};

export type ConnectionInput = {
  id: string;
  name: string;
  timezone: string | null;
  /** ems_type: null when no backend is configured, which is not a failure. */
  emsType: string | null;
  status: string | null;
  checkedAt: string | null;
};

/** One signal per configured microgrid whose last check failed, by name, at most MAX_SIGNALS_PER_SOURCE. */
export function buildConnectionSignals(fmt: Fmt, microgrids: readonly ConnectionInput[], now: Date): SignalOut[] {
  return microgrids
    .flatMap((m) => (m.emsType !== null && isFailingDiscoverStatus(m.status) ? [{ ...m, status: m.status }] : []))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, MAX_SIGNALS_PER_SOURCE)
    .map((m): SignalOut => {
      const checked = m.checkedAt === null || Number.isNaN(Date.parse(m.checkedAt)) ? null : new Date(m.checkedAt).toISOString();
      const zone = m.timezone !== null && isSupportedTimezone(m.timezone) ? m.timezone : "UTC";
      return {
        id: m.id,
        kind: "alarm",
        severity: "warn",
        title: `${m.name}: ${CONNECTION_COPY[m.status]}`,
        ...(checked ? { facts: [fmt.datetime(checked, zone)] } : {}),
        entity: { kind: "microgrid", id: m.id, label: m.name },
        href: `/microgrids/${m.id}/setup/openems-backend`,
        at: checked ?? now.toISOString(),
      };
    });
}
