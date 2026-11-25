import type { DeviceConfig, DeviceDataAdapter, DeviceReading } from "@/lib/adapters/types";
import { OpenEmsError } from "./errors";
import { dayKeyInZone } from "@/lib/timezone/day-key";
import { validateBackendUrl } from "./backend-url";
import type { OpenEmsAuth } from "./auth";
import type {
  ChannelValue,
  EdgeConfig,
  EdgeStatus,
  JsonRpcErrorResponse,
  JsonRpcResponse,
} from "./types";

/**
 * Channel address convention for OpenEMS consumption meters:
 *   `${componentId}/ActiveConsumptionEnergy`
 * This suffix is OpenEMS-specific. Non-consumption channels (battery SoC, PV
 * production) would resolve their channel name from device_type in the adapter.
 */
function consumptionChannelAddress(componentId: string): string {
  return `${componentId}/ActiveConsumptionEnergy`;
}

type RpcOptions = { timeoutMs?: number; signal?: AbortSignal };

export class OpenEmsClient implements DeviceDataAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: OpenEmsAuth
  ) {}

  /**
   * Send a JSON-RPC request to the OpenEMS B2B REST endpoint.
   */
  private async rpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options: RpcOptions = {}
  ): Promise<T> {
    // INVARIANT: the same `body` string MUST be passed to both `auth.apply`
    // (which hashes it for the SigV4 signature) AND `fetch` (which transmits it).
    // Any byte-level divergence breaks the signature and returns 403.
    const body = JSON.stringify({
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method,
      params,
    });

    // Re-validate at the sink, immediately before the request is signed and
    // sent. This is defence in depth, not a substitute for the
    // write-time check in the save route — the two cover different data.
    //
    // Write-time validation only governs rows written after it shipped. Every
    // `ems_backend_url` stored before then reached the database without ever
    // being checked, and this is the only place that catches those. Validating
    // the resolved URL (rather than `this.baseUrl`) means the exact string
    // handed to `fetch` is the string that passed.
    const resolved = this.auth.resolveUrl(this.baseUrl);
    const checked = validateBackendUrl(resolved);
    if (!checked.ok) {
      throw new OpenEmsError(
        `The saved OpenEMS backend URL was not contacted because it is not valid: ${checked.error} ` +
          `Open the microgrid's OpenEMS Backend setup and save a valid URL.`,
        "OPENEMS_INVALID_BACKEND_URL",
        503,
        { baseUrl: this.baseUrl }
      );
    }
    const url = checked.url;

    // The caller's signal (a deadline shared by several requests, say) and
    // this request's own timeout, whichever ends first.
    const ownTimeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signals = [options.signal, ownTimeout].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const timedOut = (cause: unknown) =>
      new OpenEmsError(
        `OpenEMS at ${this.baseUrl} did not answer within ` +
          // Name the seconds only when it was this request's own timeout.
          (options.timeoutMs && (ownTimeout?.aborted || !options.signal?.aborted)
            ? `${Math.round(options.timeoutMs / 1000)} s`
            : "the time allowed"),
        "OPENEMS_UNREACHABLE",
        503,
        cause
      );
    // A transport failure, while sending or while reading the reply: a
    // deadline ending is a timeout, anything else a failure to reach it.
    const transportError = (err: unknown) =>
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? timedOut(err)
        : new OpenEmsError(
            `Failed to reach OpenEMS at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
            "OPENEMS_UNREACHABLE",
            503,
            err
          );
    // A deadline that has already passed starts no request.
    if (signal?.aborted) throw timedOut(signal.reason);

    const headers = await this.auth.apply({ url, method: "POST", body });
    if (signal?.aborted) throw timedOut(signal.reason);

    let response: Response;
    try {
      // `redirect: "manual"` — we do NOT follow redirects.
      //
      // fetch defaults to `follow`, which means the URL an operator saved and
      // saw validated is not necessarily the URL their data reaches: a 308 at
      // request time re-sends the POST — body included, which in direct_url
      // mode is the whole JSON-RPC payload — to a host that never passed the
      // write-time checks in `backend-url.ts`. A control that a redirect can
      // sidestep is not a control, so the redirect is surfaced to the operator
      // instead, with the instruction to store the final URL.
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw transportError(err);
    }

    // A redirect is a configuration problem, not a transport detail. Checked
    // before the auth and JSON branches — a 3xx body is not JSON-RPC.
    // With `redirect: "manual"` the runtime surfaces either the raw 3xx or an
    // opaque redirect (type "opaqueredirect", status 0); handle both.
    if (
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect"
    ) {
      const location = response.headers.get("location");
      throw new OpenEmsError(
        `OpenEMS Backend at ${this.baseUrl} responded with a redirect` +
          (location ? ` to ${location}` : "") +
          `. Redirects are not followed — update the saved backend URL to the final address.`,
        "OPENEMS_REDIRECT",
        502,
        { status: response.status, location }
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new OpenEmsError(
        "OpenEMS B2B authentication failed",
        "OPENEMS_AUTH_FAILED",
        response.status
      );
    }

    // Everything that is not 2xx, and not one of the two shapes handled above,
    // stops here carrying the evidence (#325).
    //
    // Before this existed, control fell straight through to `response.json()`,
    // so a 404, 405, 500 or 502 threw a bare `SyntaxError` on the HTML body —
    // not an `OpenEmsError`, so the route's outer catch reported "Edge
    // validation failed with an unexpected error. Check server logs." The
    // cause existed only in the server log, and diagnosing one real incident
    // took three people probing the operator's host directly.
    //
    // The status and the first bytes are the whole point: "returned HTTP 405"
    // and "returned HTTP 502" send an operator to different places, and both
    // are things they can act on without us.
    //
    // NOTE — this is where an OpenEMS auth failure actually lands. OpenEMS
    // Backend answers an unauthenticated JSON-RPC call with **500** and
    // `OpenemsNamedException: Authentication failed` in the body, not with
    // 401/403, so the branch above never fires for it. Matching on the body
    // text to re-classify it was considered and rejected: it is a different
    // failure mode dressed as a string comparison, and the message below
    // already names the cause verbatim. If OpenEMS ever starts sending 401,
    // the branch above catches it and this comment is what tells you why the
    // reason code changed.
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Single read: this branch throws, so the stream is never needed again.
      throw new OpenEmsError(
        `OpenEMS Backend at ${this.baseUrl} returned HTTP ${response.status}: ${body.slice(0, 500)}`,
        "OPENEMS_HTTP_ERROR",
        502,
        { status: response.status, body: body.slice(0, 500) }
      );
    }

    // A 2xx that is not JSON. Deliberately NOT gated on Content-Type: plenty of
    // servers return valid JSON as `text/plain` or with no Content-Type at all,
    // and making the header a precondition invents failures for setups that
    // work today. The parse is the thing that genuinely cannot proceed — so let
    // the parse decide, and put the content-type in the message where it does
    // diagnostic work instead.
    //
    // The case this catches: a single-page-app catch-all that answers every
    // path with `200 text/html`, which is what an operator gets when the URL
    // points at an OpenEMS UI rather than at the Backend's REST API.
    // Read the body ONCE, as text, then parse it. `response.json()` consumes
    // the stream, so a `response.text()` in the catch would read an already-
    // used body and yield "" — an error message promising the first bytes and
    // delivering none, which is worse than not offering them.
    // The body arrives after the headers, under the same signal: a deadline
    // that ends while it streams is a timeout, as it is during the fetch.
    let raw: string;
    try {
      raw = await response.text();
    } catch (err) {
      throw transportError(err);
    }

    let json: { error?: { message?: string } } & Record<string, unknown>;
    try {
      json = JSON.parse(raw);
    } catch {
      const contentType = response.headers.get("content-type") ?? "unknown";
      const body = raw;
      throw new OpenEmsError(
        `OpenEMS Backend at ${this.baseUrl} returned ${contentType}, not JSON. ` +
          `Check that the URL points at the Backend's JSON-RPC API rather than the OpenEMS UI. ` +
          `First bytes: ${body.slice(0, 200)}`,
        "OPENEMS_NOT_JSON",
        502,
        { contentType, body: body.slice(0, 200) }
      );
    }

    if ("error" in json) {
      throw new OpenEmsError(
        `OpenEMS RPC error: ${json.error?.message}`,
        "OPENEMS_RPC_ERROR",
        502,
        json.error
      );
    }

    return (json as JsonRpcResponse<T>).result;
  }

  /**
   * Get online/offline status for a list of edges. `options` as for
   * queryHistoricSamples: a timeout of this request's own, or a signal to
   * give up on; neither set waits as long as the platform allows.
   */
  async getEdgesStatus(edgeIds: string[], options: RpcOptions = {}): Promise<EdgeStatus[]> {
    const result = await this.rpc<Record<string, { online: boolean }>>(
      "getEdgesStatus",
      { edgeIds },
      options
    );

    return Object.entries(result).map(([edgeId, status]) => ({
      edgeId,
      online: status.online,
    }));
  }

  /**
   * Get the full configuration of an edge (components + factories).
   */
  async getEdgeConfig(edgeId: string): Promise<EdgeConfig> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<EdgeConfig>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "getEdgeConfig",
        params: {},
      },
    });

    return result.payload.result;
  }

  /**
   * Query historic energy data for a single edge.
   * Returns cumulative energy values per channel in Wh.
   */
  async queryHistoricEnergy(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string = "UTC"
  ): Promise<Record<string, number | null>> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<{ data: Record<string, number | null> }>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "queryHistoricTimeseriesEnergy",
        params: {
          fromDate,
          toDate,
          channels,
          timezone,
        },
      },
    });

    return result.payload.result.data;
  }

  /**
   * Get current channel values across multiple edges.
   */
  async getEdgesChannelsValues(
    edgeIds: string[],
    channels: string[]
  ): Promise<ChannelValue[]> {
    const result = await this.rpc<
      Record<string, Record<string, number | null>>
    >("getEdgesChannelsValues", {
      ids: edgeIds,
      channels,
    });

    const values: ChannelValue[] = [];
    for (const [edgeId, channelData] of Object.entries(result)) {
      for (const [channelAddress, value] of Object.entries(channelData)) {
        values.push({ edgeId, channelAddress, value });
      }
    }
    return values;
  }

  /**
   * Implement DeviceDataAdapter.getStatus.
   */
  async getStatus(
    edgeIds: string[]
  ): Promise<Record<string, { online: boolean }>> {
    const statuses = await this.getEdgesStatus(edgeIds);
    const result: Record<string, { online: boolean }> = {};
    for (const s of statuses) {
      result[s.edgeId] = { online: s.online };
    }
    return result;
  }

  /**
   * Implement DeviceDataAdapter.getReadings.
   * Groups devices by edgeOpenemsId, batches channel queries per edge,
   * and converts Wh to kWh.
   *
   * Channel address: `${componentId}/ActiveConsumptionEnergy` (OpenEMS convention).
   *
   * `timezone` (IANA name) is forwarded verbatim to `queryHistoricEnergy`, so
   * OpenEMS builds the local-day window — including DST transitions — from the
   * zone name. No offset arithmetic happens on this side (#355).
   */
  async getReadings(
    devices: DeviceConfig[],
    startDate: string,
    endDate: string,
    timezone: string
  ): Promise<DeviceReading[]> {
    // Validate and group devices by OpenEMS edge ID
    const edgeGroups = new Map<
      string,
      { deviceId: string; channelAddress: string }[]
    >();

    for (const device of devices) {
      if (!device.edgeOpenemsId || !device.componentId) {
        throw new OpenEmsError(
          `Device ${device.id} has invalid config: missing edgeOpenemsId or componentId`,
          "DEVICE_INVALID_DATA_SOURCE",
          400,
          { deviceId: device.id }
        );
      }

      const channelAddress = consumptionChannelAddress(device.componentId);
      const group = edgeGroups.get(device.edgeOpenemsId) ?? [];
      group.push({ deviceId: device.id, channelAddress });
      edgeGroups.set(device.edgeOpenemsId, group);
    }

    // Query each edge in parallel.
    // (Each DeviceConfig doesn't carry a URL anymore — the client was
    // constructed with a microgrid-scoped URL, applied to every edge
    // under that microgrid.)
    const results: DeviceReading[] = [];
    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, deviceInfos]) => {
        const channels = deviceInfos.map((d) => d.channelAddress);
        const data = await this.queryHistoricEnergy(
          edgeId,
          channels,
          startDate,
          endDate,
          timezone
        );

        for (const deviceInfo of deviceInfos) {
          const whValue = data[deviceInfo.channelAddress] ?? null;
          results.push({
            deviceId: deviceInfo.deviceId,
            usageKwh: whValue !== null ? whValue / 1000 : null,
            startDate,
            endDate,
          });
        }
      }
    );

    await Promise.all(edgeQueries);
    return results;
  }

  /**
   * Query per-day energy totals for a single edge across a date range.
   *
   * Uses the OpenEMS `queryHistoricTimeseriesEnergyPerPeriod` method, which
   * returns per-day energy consumption (Wh) for each channel.
   *
   * Returns a map of { date (YYYY-MM-DD) → totalKwh } summed across all channels.
   * Days with no data for any channel are omitted from the result.
   *
   * The day-KEYS are bucketed in `timezone` (#359), not just the query
   * window: OpenEMS returns period-start timestamps at local midnight in
   * the requested zone, and `toISOString().slice(0, 10)` would name the
   * UTC day — 21:00 the previous day for a Kampala midnight — so a
   * tz-aware query with UTC binning still lands values in the wrong cell.
   */
  async queryDailyEnergy(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string = "UTC"
  ): Promise<Record<string, number>> {
    const byChannel = await this.queryDailyEnergyByChannel(
      edgeId, channels, fromDate, toDate, timezone
    );
    const byDate: Record<string, number> = {};
    for (const days of Object.values(byChannel)) {
      for (const [date, kwh] of Object.entries(days)) {
        byDate[date] = (byDate[date] ?? 0) + kwh;
      }
    }
    return byDate;
  }

  /**
   * Per-channel daily coverage; absent dates are unavailable, never zero.
   * Each date holds the backend's daily bucket, which on NFE's backend is the
   * UTC day stamped at local midnight (see queryEnergyPerPeriod), so in
   * Kampala a date runs 03:00 to 03:00. If daily buckets ever follow the
   * requested zone, this note goes.
   */
  async queryDailyEnergyByChannel(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string = "UTC"
  ): Promise<Record<string, Record<string, number>>> {
    const { timestamps, data } = await this.queryEnergyPerPeriod(
      edgeId, channels, fromDate, toDate, timezone, "Days"
    );
    const byChannel: Record<string, Record<string, number>> = {};

    for (let i = 0; i < timestamps.length; i++) {
      const dateStr = dayKeyInZone(new Date(timestamps[i]), timezone);
      for (const [channel, channelValues] of Object.entries(data)) {
        const wh = channelValues[i];
        if (wh !== null && wh !== undefined) {
          const days = byChannel[channel] ?? {};
          days[dateStr] = (days[dateStr] ?? 0) + wh / 1000;
          byChannel[channel] = days;
        }
      }
    }

    return byChannel;
  }

  /**
   * Energy per period (Wh) for each channel, as OpenEMS's
   * queryHistoricTimeseriesEnergyPerPeriod returns it: one bucket per `unit`
   * over whole local days `fromDate`..`toDate` (inclusive) in `timezone`, null
   * where the backend has no value. Raw: no keying, summing or null dropping.
   * `options` as for queryHistoricSamples.
   *
   * What a stamp means is the backend's, not the zone's (NFE's backend,
   * observed 19 November 2026): an hourly bucket is stamped at the END of its
   * hour, and a daily bucket is stamped at local midnight but holds the UTC
   * day. The tenant usage reads hours and handles this in
   * `getDeviceEnergySeries` (`src/lib/metering/openems-provider.ts`).
   */
  async queryEnergyPerPeriod(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string,
    unit: "Hours" | "Days",
    options: RpcOptions = {}
  ): Promise<{ timestamps: Array<number | string>; data: Record<string, (number | null)[]> }> {
    const result = await this.rpc<{
      payload:
        | JsonRpcResponse<{
            timestamps: Array<number | string>;
            data: Record<string, (number | null)[]>;
          }>
        | JsonRpcErrorResponse;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "queryHistoricTimeseriesEnergyPerPeriod",
        params: {
          fromDate,
          toDate,
          channels,
          timezone,
          resolution: { value: 1, unit },
        },
      },
    }, options);
    // The edge's own answer travels inside the backend's, so its error can
    // come back there, in place of the result, inside a successful outer
    // reply: it is an RPC error, as one in the outer reply is.
    const { payload } = result;
    if ("error" in payload) {
      throw new OpenEmsError(
        `OpenEMS RPC error: ${payload.error?.message}`,
        "OPENEMS_RPC_ERROR",
        502,
        payload.error
      );
    }
    return payload.result;
  }

  /** Fifteen-minute channel samples used only to prove billing coverage. */
  async queryHistoricCoverageSamples(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string
  ): Promise<{ timestamps: Array<number | string>; data: Record<string, (number | null)[]> }> {
    return this.queryHistoricSamples(edgeId, channels, fromDate, toDate, timezone, 15);
  }

  /**
   * How long a page's history read may wait for OpenEMS, all of its
   * requests together.
   */
  static readonly PAGE_READ_TIMEOUT_MS = 20_000;

  /**
   * Channel samples at a fixed resolution in minutes, as OpenEMS aggregates
   * them (the mean of each bin; `null` where the edge sent nothing). The
   * dates are whole local days in `timezone`, `toDate` inclusive.
   */
  async queryHistoricSamples(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string,
    resolutionMinutes: number,
    /**
     * `timeoutMs`: give up on this request after this long. `signal`: give
     * up when it aborts (a deadline shared by several requests). Neither
     * set waits as long as the platform allows.
     */
    options: RpcOptions = {}
  ): Promise<{ timestamps: Array<number | string>; data: Record<string, (number | null)[]> }> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<{
        timestamps: Array<number | string>;
        data: Record<string, (number | null)[]>;
      }>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "queryHistoricTimeseriesData",
        params: {
          fromDate,
          toDate,
          channels,
          timezone,
          resolution: { value: resolutionMinutes, unit: "Minutes" },
        },
      },
    }, options);
    return result.payload.result;
  }
}
