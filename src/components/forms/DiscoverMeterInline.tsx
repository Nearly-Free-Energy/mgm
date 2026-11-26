"use client";

/**
 * DiscoverMeterInline — single-pick consumption-meter discovery for the
 * Add-Tenant wizard's Step 3 (#200).
 *
 * Distinct from `<DiscoverDevices>` (the multi-pick edge-detail surface):
 *   - single-pick RadioGroup (one meter at a time)
 *   - filters discovery results to consumption_meter only
 *   - persists via POST /api/devices, then hands the saved device back to
 *     the wizard via `onDevicePersisted` so the parent can append it to
 *     `availableMeters` and auto-select it; the saved meter then leaves
 *     the candidates, as it would on the next discover
 *   - errors are owned + rendered inline (no `onError` callback)
 *   - consumption meters the route skipped because MGM cannot store their id
 *     (`skipped` in the response, by its `suggestedDeviceType`) are named in a
 *     note; skipped components of other types are left out of it, since this
 *     surface offers only consumption meters (`<DiscoverDevices>` names all)
 *   - both fetches are guarded by a single AbortController so that an
 *     in-flight request doesn't leak results into a re-mounted instance
 *     (the wizard re-mounts on `state.no_meter` toggle via `key={…}`)
 *
 * Component contract (per ticket #200 Dev Notes):
 *   {
 *     edges: { id, name, openems_edge_id }[];
 *     edgeIdsWithoutConsumptionMeter: string[];
 *     microgridId: string;
 *     onDevicePersisted: (device: AvailableMeter) => void;
 *   }
 */

import * as React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  DiscoveredDevice,
  EdgeDiscoveryResponse,
  SkippedComponent,
} from "@/lib/openems/types";
import { humanReadable } from "@/lib/openems/device-descriptions";
import type { AvailableMeter } from "@/components/forms/TenantWizard";

export type DiscoverMeterInlineEdge = {
  id: string;
  name: string;
  openems_edge_id: string;
};

type Props = {
  edges: DiscoverMeterInlineEdge[];
  edgeIdsWithoutConsumptionMeter: string[];
  /** Reserved for future per-microgrid scoping; not used in current contract. */
  microgridId: string;
  /** Called after POST /api/devices succeeds; parent appends + auto-selects. */
  onDevicePersisted: (device: AvailableMeter) => void;
};

type Phase = "idle" | "discovering" | "ready" | "saving";

/** The one device type this surface offers, and names when skipped. */
const OFFERED_TYPE = "consumption_meter";

/**
 * Sort edges by (name, id) ascending — name first, id as a deterministic
 * tie-break for collidable names.
 */
function sortEdges(edges: DiscoverMeterInlineEdge[]): DiscoverMeterInlineEdge[] {
  return [...edges].sort((a, b) => {
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.id.localeCompare(b.id);
  });
}

/**
 * Default-edge selector. Pre-selects the first edge in
 * `edgeIdsWithoutConsumptionMeter` sorted by (name, id) ascending; falls
 * back to the alphabetically first edge by (name, id) if every edge already
 * has at least one consumption_meter.
 */
function pickDefaultEdgeId(
  sortedEdges: DiscoverMeterInlineEdge[],
  edgeIdsWithoutConsumptionMeter: string[]
): string | null {
  if (sortedEdges.length === 0) return null;
  const withoutSet = new Set(edgeIdsWithoutConsumptionMeter);
  const firstWithout = sortedEdges.find((e) => withoutSet.has(e.id));
  return firstWithout?.id ?? sortedEdges[0].id;
}

/**
 * Devices discovery did not classify as consumption meters, each with its
 * type, and how to offer one of them here.
 */
function UnofferedDevices({ devices }: { devices: DiscoveredDevice[] }) {
  return (
    <>
      <ul className="mt-2 space-y-1">
        {devices.map((d) => (
          <li key={d.componentId} className="font-mono text-xs">
            {d.alias || d.componentId}
            <span className="ml-2 font-sans text-muted-foreground">
              — {humanReadable(d.suggestedDeviceType)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2">
        If one of these meters a tenant, open it on the edge&apos;s device
        list and change its type to Consumption meter.
      </p>
    </>
  );
}

export function DiscoverMeterInline({
  edges,
  edgeIdsWithoutConsumptionMeter,
  onDevicePersisted,
}: Props) {
  const sortedEdges = React.useMemo(() => sortEdges(edges), [edges]);

  const [pickedEdgeId, setPickedEdgeId] = React.useState<string>(
    () => pickDefaultEdgeId(sortedEdges, edgeIdsWithoutConsumptionMeter) ?? ""
  );
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [discovered, setDiscovered] = React.useState<DiscoveredDevice[]>([]);
  const [skipped, setSkipped] = React.useState<SkippedComponent[]>([]);
  const [edgeOnline, setEdgeOnline] = React.useState<boolean>(true);
  const [pickedComponentId, setPickedComponentId] = React.useState<string>("");
  const [editedName, setEditedName] = React.useState<string>("");
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // One AbortController guards both GET /discover-devices and POST /api/devices.
  // Cleanup aborts on unmount; the wizard re-mounts this component via
  // `key={state.no_meter}` whenever the user toggles the manual-billing
  // checkbox, so the unmount path is the canonical "cancel pending fetches"
  // signal.
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return () => {
      ctrl.abort();
      abortRef.current = null;
    };
  }, []);

  // The edge picked now, for a save that returns after the operator picked
  // another: its outcome belongs to the list of the edge it was sent for.
  // Written where the edge changes, not during render.
  const pickedEdgeIdRef = React.useRef(pickedEdgeId);

  const pickedEdge = sortedEdges.find((e) => e.id === pickedEdgeId) ?? null;

  // Filter discovery results to consumption_meter not yet linked.
  // The `openemsChannelAddress !== null` check is dropped per ticket #200:
  // channelAddressFor() always returns non-null for consumption_meter, so
  // the predicate is redundant.
  const candidates = React.useMemo(
    () =>
      discovered.filter(
        (d) => d.suggestedDeviceType === OFFERED_TYPE && d.alreadyAdded !== true
      ),
    [discovered]
  );

  // Unsaved devices discovery did not classify as consumption meters. When
  // no new consumption meter is offered, these are named with the hint to
  // change a device's type, since one of them may meter a tenant. A saved
  // device is left out: its type was chosen when it was saved, while an
  // unsaved one carries only discovery's guess.
  const unofferedUnsaved = React.useMemo(
    () =>
      discovered.filter(
        (d) => d.suggestedDeviceType !== OFFERED_TYPE && d.alreadyAdded !== true
      ),
    [discovered]
  );

  // Only the skipped components this surface would have offered: a skipped
  // battery or inverter is no meter left out.
  const skippedMeters = React.useMemo(
    () => skipped.filter((s) => s.suggestedDeviceType === OFFERED_TYPE),
    [skipped]
  );

  const handleDiscover = React.useCallback(async () => {
    if (!pickedEdge) return;
    setPhase("discovering");
    setDiscoverError(null);
    setSaveError(null);
    setDiscovered([]);
    setSkipped([]);
    setPickedComponentId("");
    setEditedName("");
    setEdgeOnline(true);

    try {
      const res = await fetch(
        `/api/edges/${encodeURIComponent(pickedEdge.id)}/discover-devices`,
        { signal: abortRef.current?.signal }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDiscoverError(
          body.error ?? `Discovery failed (HTTP ${res.status}).`
        );
        setPhase("idle");
        return;
      }
      const data = (await res.json()) as EdgeDiscoveryResponse;
      setEdgeOnline(data.online);
      setDiscovered(data.devices ?? []);
      setSkipped(data.skipped ?? []);
      setPhase("ready");
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setDiscoverError(
        "Could not reach the server. Check your network connection."
      );
      setPhase("idle");
    }
  }, [pickedEdge]);

  const handlePick = React.useCallback(
    (componentId: string) => {
      setPickedComponentId(componentId);
      const candidate = candidates.find((d) => d.componentId === componentId);
      if (candidate) {
        setEditedName(candidate.alias || candidate.componentId);
      }
      setSaveError(null);
    },
    [candidates]
  );

  const handleSave = React.useCallback(async () => {
    if (!pickedEdge) return;
    const candidate = candidates.find((d) => d.componentId === pickedComponentId);
    if (!candidate) return;
    // The edge this save is for. The edge picker stays open while it runs,
    // and picking another edge clears the list, so the list a save returns
    // to may be another edge's, where the same component id can name a
    // different device.
    const savingEdgeId = pickedEdge.id;
    const edgeChanged = () => pickedEdgeIdRef.current !== savingEdgeId;
    setSaveError(null);
    setPhase("saving");

    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edgeId: pickedEdge.id,
          devices: [
            {
              componentId: candidate.componentId,
              factoryId: candidate.factoryId,
              deviceType: "consumption_meter",
              name: editedName.trim() || candidate.alias || candidate.componentId,
            },
          ],
        }),
        signal: abortRef.current?.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // Picking another edge discarded this pick, so its refusal has no
        // selection left to retry.
        if (edgeChanged()) return;
        setSaveError(
          body.error ??
            `Could not save the device (HTTP ${res.status}). Your selection is preserved — please retry.`
        );
        setPhase("ready");
        return;
      }

      const data = (await res.json()) as {
        saved: Array<{
          id: string;
          name: string;
          device_type: string;
          openems_component_id: string | null;
        }>;
      };
      const saved = data.saved?.[0];
      if (!saved) {
        if (edgeChanged()) return;
        setSaveError("Server did not return the saved device. Please retry.");
        setPhase("ready");
        return;
      }

      // Construct the AvailableMeter from the picked-edge object in scope —
      // POST /api/devices does not return edge_id / edge_name. Freshly-saved
      // devices are never linked, so linked_tenant_name is null.
      const newMeter: AvailableMeter = {
        id: saved.id,
        name: saved.name,
        device_type: saved.device_type as AvailableMeter["device_type"],
        edge_id: pickedEdge.id,
        edge_name: pickedEdge.name,
        linked_tenant_name: null,
      };

      onDevicePersisted(newMeter);
      // The meter is saved on its edge whichever edge is picked now, so the
      // wizard gets it above. The list here is another edge's once the
      // operator has picked one, and marking its device with the same
      // component id would take a meter that is not saved out of the
      // candidates, so the list and the pick are left as they are.
      if (edgeChanged()) return;
      // The meter is saved now, and the wizard's own meter list holds it
      // and selects it. Mark it `alreadyAdded`, as the next discover would,
      // so it leaves the candidates: picking it here again would send it to
      // POST /api/devices a second time, which refuses a saved device (409
      // metering_devices_already_saved). Phase goes back to 'ready' rather
      // than 'idle' because the rest of the discovery list still applies.
      setDiscovered((prev) =>
        prev.map((d) =>
          d.componentId === candidate.componentId ? { ...d, alreadyAdded: true } : d
        )
      );
      setPickedComponentId("");
      setEditedName("");
      setPhase("ready");
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      if (edgeChanged()) return;
      setSaveError(
        "Network error while saving. Your selection is preserved — please retry."
      );
      setPhase("ready");
    }
  }, [pickedEdge, candidates, pickedComponentId, editedName, onDevicePersisted]);

  if (sortedEdges.length === 0) {
    return null;
  }

  const isDiscovering = phase === "discovering";
  const isSaving = phase === "saving";
  const showResults = phase === "ready" || phase === "saving";

  return (
    <section
      aria-label="Discover meters on an edge"
      className="space-y-3 rounded-md border border-border bg-card p-3"
    >
      <header className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">
          Discover meters on an edge
        </h4>
      </header>
      <p className="text-xs text-muted-foreground">
        Scan an edge for new consumption meters and link one directly to this
        tenant — no need to leave the wizard.
      </p>

      {/* Edge picker. Collapses to a static label when there's exactly one. */}
      {sortedEdges.length === 1 ? (
        <div className="text-sm text-foreground">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Edge:
          </span>{" "}
          {sortedEdges[0].name}
        </div>
      ) : (
        <div>
          <label
            htmlFor="dmi-edge-select"
            className="mb-1 block text-caption font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Edge
          </label>
          <Select
            value={pickedEdgeId}
            onValueChange={(v) => {
              pickedEdgeIdRef.current = v;
              setPickedEdgeId(v);
              setDiscovered([]);
              setSkipped([]);
              setPickedComponentId("");
              setEditedName("");
              setDiscoverError(null);
              setSaveError(null);
              setPhase("idle");
            }}
          >
            <SelectTrigger id="dmi-edge-select">
              <SelectValue placeholder="Pick an edge" />
            </SelectTrigger>
            <SelectContent>
              {sortedEdges.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleDiscover}
          disabled={!pickedEdge || isDiscovering || isSaving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDiscovering ? "Scanning…" : "Discover meters"}
        </button>
      </div>

      {discoverError && (
        <div className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {discoverError}
          <button
            type="button"
            onClick={handleDiscover}
            className="ml-2 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {showResults && !edgeOnline && (
        <div className="rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
          Edge is offline — retry when it reconnects.
        </div>
      )}

      {showResults && edgeOnline && skippedMeters.length > 0 && (
        <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
          Not listed: {skippedMeters.length} consumption meter
          {skippedMeters.length !== 1 ? "s" : ""} whose OpenEMS id MGM cannot
          store (ids are 1 to 64 letters, digits, &apos;_&apos;, &apos;.&apos;,
          &apos;:&apos; or &apos;-&apos;):{" "}
          <span className="font-mono break-all">
            {skippedMeters.map((s) => s.componentId).join(", ")}
          </span>
        </p>
      )}

      {/* Two distinct states, previously collapsed into one message (#335).
          `discovered.length === 0` is genuinely "nothing found" and the
          original copy is correct for it. `discovered.length > 0` with no
          candidates means devices WERE found and none classify as consumption
          meters — and the old sentence told the operator to check that the
          edge was online and had components configured, both of which are
          already true in that branch (it is guarded by `edgeOnline`, and
          discovery returned devices). That sent a pilot operator to rename his
          meter to contain a keyword, when the device-type control has existed
          since #151. When discovery skipped components of any type, the edge
          is reachable and configured, so the first branch leaves that hint
          out too, even when the note above names none of them. A consumption
          meter that is already saved (one saved from this list included) is
          not unclassified: when every consumption meter found is saved, there
          is simply no new one, and the edge is reachable and configured, so
          the hint stays out. Unsaved devices of other types found beside
          them are still named, with the hint to change a device's type, as
          the second branch names them. */}
      {showResults && edgeOnline && candidates.length === 0 && (
        discovered.length === 0 ||
        discovered.some((d) => d.suggestedDeviceType === OFFERED_TYPE) ? (
          <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            <p>
              No new consumption meters on this edge.
              {discovered.length === 0 &&
                skipped.length === 0 &&
                " Make sure the edge is online and has components configured."}
            </p>
            {unofferedUnsaved.length > 0 && (
              <>
                <p className="mt-2 text-foreground">
                  Also found {unofferedUnsaved.length}{" "}
                  {unofferedUnsaved.length === 1 ? "device" : "devices"} not
                  classified as a consumption meter:
                </p>
                <UnofferedDevices devices={unofferedUnsaved} />
              </>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            <p className="text-foreground">
              Found {discovered.length}{" "}
              {discovered.length === 1 ? "device" : "devices"} on this edge, but{" "}
              {discovered.length === 1 ? "it is not" : "none are"} classified as
              a consumption meter, so{" "}
              {discovered.length === 1 ? "it cannot" : "none can"} bill a
              tenant.
            </p>
            <UnofferedDevices devices={discovered} />
          </div>
        )
      )}

      {showResults && candidates.length > 0 && (
        <div className="space-y-3">
          <RadioGroup
            value={pickedComponentId}
            onValueChange={handlePick}
            aria-label="Discovered consumption meters"
            className="gap-2"
          >
            {candidates.map((c) => {
              const id = `dmi-cand-${c.componentId}`;
              return (
                <label
                  key={c.componentId}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 hover:bg-muted"
                >
                  <RadioGroupItem id={id} value={c.componentId} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {c.alias || c.componentId}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {c.componentId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.factoryId}
                    </div>
                  </div>
                </label>
              );
            })}
          </RadioGroup>

          {pickedComponentId && (
            <div className="space-y-2 rounded-md border border-border bg-muted p-3">
              <div>
                <label
                  htmlFor="dmi-name"
                  className="mb-1 block text-caption font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Device name
                </label>
                <Input
                  id="dmi-name"
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  placeholder="Device name"
                />
              </div>
              {saveError && (
                <div className="rounded-md bg-destructive-muted p-2 text-xs text-destructive-fg">
                  {saveError}
                </div>
              )}
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving || !editedName.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? "Saving…" : "Save & select"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
