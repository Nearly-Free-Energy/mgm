/**
 * The meter read of the cached edge-status read (../edge-status.ts): which
 * of a microgrid's meters have sent no reading lately, from each meter's
 * power history on its edge (mgm#287: a gateway can be online while a meter
 * on it has stopped reporting, a loose Modbus cable or a meter that lost
 * power, which getEdgesStatus cannot see).
 *
 * Meters only: the device types whose OpenEMS component is an
 * ElectricityMeter, which always has an `ActivePower` channel. A battery,
 * an inverter or an EV charger is left out, because which power channel it
 * has depends on its driver or OpenEMS version (Discover lists chargers by
 * the Evcs nature, apart from meters), and asking for one it lacks would
 * read as a quiet device for ever.
 *
 * A meter is quiet when its `ActivePower` history, at five-minute
 * resolution, has no value in any bin that overlaps the last
 * METER_QUIET_AFTER_MS. Bins are counted from one bin before that window,
 * so the answer is the same whether OpenEMS stamps a bin at its start or
 * its end. A channel with no history in the dates asked for (OpenEMS
 * refuses the batch, and then that channel alone) is quiet too: a meter
 * that never reported, or stopped before yesterday, is as silent as one
 * that stopped an hour ago. Such channels are remembered per process
 * (NO_HISTORY_MAX), so the next read asks the others in one batch and each
 * remembered one on its own, instead of having the batch refused and every
 * channel asked one by one again; a remembered channel that answers is
 * forgotten.
 *
 * Each edge answers on its own: an edge whose requests fail (an edge the
 * backend does not know, a timeout), or whose answer MGM cannot read
 * (instants it cannot parse, no bins at all), is listed as failed, never
 * its meters called quiet, and the other edges' meters still count. The
 * reader (./openems-edge-status.ts) ignores a failed edge that the status
 * answer says is offline.
 */
import "server-only";

import type { createOpenEmsClient } from "@/lib/openems";
import type { DeviceType } from "@/lib/types/domain";
import { isNoEnergyData, toEpochMs, type SampleSet } from "../openems-provider";
import type { MeterActivityRead, MeterRef } from "./edge-status-cache";

/**
 * How long a meter may send nothing before it is called quiet. Half an
 * hour: long enough that a reading delayed on its way to the backend, or a
 * gap of a bin or two, is not reported, short enough that a meter that
 * stopped shows the same morning.
 */
export const METER_QUIET_AFTER_MS = 30 * 60_000;
/** The history's resolution, in minutes: OpenEMS's own default for a day. */
export const METER_SAMPLE_MINUTES = 5;
const BIN_MS = METER_SAMPLE_MINUTES * 60_000;

/** The device types asked about: those whose component is an ElectricityMeter. */
export const METER_DEVICE_TYPES = ["consumption_meter", "grid_meter", "pv_meter"] as const satisfies readonly DeviceType[];

/**
 * The most meters of one microgrid that one read asks about. Past it the
 * read fails, which the watcher reports as meters that could not be
 * checked, rather than leaving some out unseen. A microgrid's meters are
 * one per tenant and a few of its own; this is several times the largest.
 */
export const METERS_PER_MICROGRID_BOUND = 300;

export const powerChannel = (componentId: string) => `${componentId}/ActivePower`;

/** The UTC date of an instant, as OpenEMS takes `fromDate` and `toDate`. */
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Whether `channel` has a value in a bin of `set` stamped at or after
 * `sinceMs` less one bin. Throws when the set has no bins, or when most of
 * its instants cannot be read, so neither is taken for silence.
 */
export function reportedSince(set: SampleSet, channel: string, sinceMs: number): boolean {
  const times = set.timestamps.map(toEpochMs);
  const unreadable = times.filter((t) => t === null).length;
  if (times.length === 0 || unreadable * 2 > times.length) throw new Error("unreadable meter history");
  const values = set.data[channel] ?? [];
  return times.some((t, i) => t !== null && t >= sinceMs - BIN_MS && typeof values[i] === "number");
}

/** One-channel requests of one edge under way at once. */
const SINGLE_CONCURRENCY = 8;
/** Channels remembered as having no history, at most; the oldest goes first. */
export const NO_HISTORY_MAX = 5_000;
/** By microgrid, edge and channel: channels whose history request was refused for having none. */
const noHistory = new Set<string>();
const noHistoryKey = (microgridId: string, edgeId: string, channel: string) => JSON.stringify([microgridId, edgeId, channel]);
function rememberNoHistory(key: string) {
  noHistory.delete(key);
  noHistory.add(key);
  while (noHistory.size > NO_HISTORY_MAX) {
    const oldest = noHistory.values().next().value;
    if (oldest === undefined) break;
    noHistory.delete(oldest);
  }
}

/** Forgets every remembered channel; for tests only. */
export function _resetNoHistoryForTests(): void {
  noHistory.clear();
}

async function mapLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

type Query = (channels: string[]) => Promise<SampleSet>;

/**
 * The channels of `channels` that reported since `sinceMs`. One request for
 * them all; refused for a channel without history, one request each, a
 * refused one remembered and not reported. Any other error is thrown.
 */
async function reportedChannels(query: Query, channels: string[], sinceMs: number, remember: (channel: string) => void, forget: (channel: string) => void) {
  const reported = new Set<string>();
  const read = (set: SampleSet, list: string[]) => {
    for (const channel of list) if (reportedSince(set, channel, sinceMs)) reported.add(channel);
  };
  const single = async (channel: string) => {
    try {
      read(await query([channel]), [channel]);
      forget(channel);
    } catch (error) {
      if (!isNoEnergyData(error)) throw error;
      remember(channel);
    }
  };
  if (channels.length === 1) await single(channels[0]);
  else if (channels.length > 1) {
    try {
      read(await query(channels), channels);
    } catch (error) {
      if (!isNoEnergyData(error)) throw error;
      await mapLimited(channels, SINGLE_CONCURRENCY, single);
    }
  }
  return reported;
}

/**
 * The quiet meters among `meters`, and the edges whose read failed, by one
 * history request per edge for its meters' power channels (plus one each
 * for channels remembered as having no history), the edges at once. Throws
 * only when there are more than METERS_PER_MICROGRID_BOUND meters: the
 * caller records a failure. `onEdgeFailure` hears why each failed edge
 * failed, for the caller's log.
 */
export async function readMeterActivity(
  client: Pick<ReturnType<typeof createOpenEmsClient>, "queryHistoricSamples">,
  microgridId: string,
  meters: readonly MeterRef[],
  nowMs: number,
  signal: AbortSignal,
  onEdgeFailure: (error: unknown) => void = () => {},
): Promise<MeterActivityRead> {
  if (meters.length > METERS_PER_MICROGRID_BOUND) throw new Error("too many meters to check");
  const sinceMs = nowMs - METER_QUIET_AFTER_MS;
  const fromDate = utcDate(sinceMs - BIN_MS);
  const toDate = utcDate(nowMs);
  const byEdge = new Map<string, string[]>();
  for (const { edgeId, componentId } of meters) {
    const components = byEdge.get(edgeId) ?? [];
    if (!components.includes(componentId)) components.push(componentId);
    byEdge.set(edgeId, components);
  }
  const quiet: MeterRef[] = [];
  const failedEdges: string[] = [];
  await Promise.all(
    [...byEdge].map(async ([edgeId, components]) => {
      const query: Query = (channels) => client.queryHistoricSamples(edgeId, channels, fromDate, toDate, "UTC", METER_SAMPLE_MINUTES, { signal });
      const key = (channel: string) => noHistoryKey(microgridId, edgeId, channel);
      const remember = (channel: string) => rememberNoHistory(key(channel));
      const forget = (channel: string) => noHistory.delete(key(channel));
      const channels = components.map(powerChannel);
      const known = channels.filter((c) => noHistory.has(key(c)));
      const rest = channels.filter((c) => !noHistory.has(key(c)));
      try {
        const answers = await Promise.all([
          reportedChannels(query, rest, sinceMs, remember, forget),
          ...known.map((channel) => reportedChannels(query, [channel], sinceMs, remember, forget)),
        ]);
        const reported = new Set(answers.flatMap((set) => [...set]));
        for (const componentId of components) {
          if (!reported.has(powerChannel(componentId))) quiet.push({ edgeId, componentId });
        }
      } catch (error) {
        failedEdges.push(edgeId);
        onEdgeFailure(error);
      }
    }),
  );
  return { quiet, failedEdges };
}
