import "server-only";

/**
 * What metering contributes to GUIs (src/lib/gui/surface.ts): the Operations
 * day as the `metering.site-day` view, with its nav entry, and navigation to
 * the pages still served outside the GUI contract (`legacy: true`), with the
 * labels the current chrome uses. A page that moves to a view keeps its nav
 * id, so the Operations entry is still `metering.operations`.
 * `metering.live` is reserved for a later live view of a microgrid. Its
 * watchers: `metering.connection` reports each microgrid whose last OpenEMS
 * connection check failed, leading to its OpenEMS Backend page, and
 * `metering.edge-status` each microgrid with a gateway offline now, or whose
 * gateways' status could not be read, from a cached read of the backend.
 *
 * Its actions are its write routes (RFC #259 § 3): saving and checking a
 * microgrid's OpenEMS connection, registering, editing and deleting edges,
 * saving and editing devices, and recording a meter's opening register.
 * No metering view offers them yet, since the setup pages are still served
 * outside the GUI contract; the action catalog does. The routes that write
 * nothing (the connection test without saving, consumption reads and
 * channel values) are not actions: their entries in UNDESCRIBED_WRITES
 * (src/lib/runtime/__tests__/route-rules.ts) say why.
 */
import type { Contribution } from "@/lib/gui/surface";
import { METERING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  CHECK_CONNECTION_BODY_VERSION,
  CheckConnectionBody,
  DELETE_EDGE_BODY_VERSION,
  DeleteEdgeBody,
  EDIT_DEVICE_BODY_VERSION,
  EDIT_EDGE_BODY_VERSION,
  EditDeviceBody,
  EditEdgeBody,
  RECORD_OPENING_REGISTER_BODY_VERSION,
  REGISTER_EDGES_BODY_VERSION,
  RecordOpeningRegisterBody,
  RegisterEdgesBody,
  SAVE_CONNECTION_BODY_VERSION,
  SAVE_DEVICES_BODY_VERSION,
  SaveConnectionBody,
  SaveDevicesBody,
} from "./schemas";
import {
  CHECK_CONNECTION_ACTION,
  DELETE_EDGE_ACTION,
  EDIT_DEVICE_ACTION,
  EDIT_EDGE_ACTION,
  RECORD_OPENING_REGISTER_ACTION,
  REGISTER_EDGES_ACTION,
  SAVE_CONNECTION_ACTION,
  SAVE_DEVICES_ACTION,
  prepareDeleteEdge,
  prepareSaveConnection,
} from "./surface/actions";
import { loadConnectionSignals } from "./surface/connection-signals";
import { CONNECTION_EXAMPLES } from "./surface/connection-signals-examples";
import { CONNECTION_SIGNAL } from "./surface/connection-signals-model";
import { EDGE_STATUS_BUDGET_MS, loadEdgeStatusSignals } from "./surface/edge-status-signals";
import { EDGE_STATUS_EXAMPLES } from "./surface/edge-status-signals-examples";
import { EDGE_STATUS_SIGNAL } from "./surface/edge-status-signals-model";
import { SITE_DAY_EXAMPLES } from "./surface/examples";
import { loadSiteDay } from "./surface/site-day";
import { SiteDayExt } from "./surface/site-day-ext";
import { SITE_DAY_EXT_SCHEMA, SITE_DAY_KEYS } from "./surface/site-day-model";

export const METERING_SURFACE: Contribution = {
  plugin: METERING_PLUGIN_NAME,
  nav: [
    {
      id: "metering.operations",
      title: "Operations",
      icon: "live",
      group: "operate",
      order: 40,
      view: "metering.site-day",
    },
    {
      id: "metering.devices",
      title: "Edges & Devices",
      icon: "devices",
      group: "operate",
      order: 60,
      href: "/microgrids/[id]/setup/edges",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "metering.data-source",
      title: "OpenEMS Backend",
      icon: "data-source",
      group: "configure",
      order: 20,
      href: "/microgrids/[id]/setup/openems-backend",
      needs: ["microgrid"],
      legacy: true,
    },
  ],
  views: [
    {
      id: "metering.site-day",
      kind: "metrics",
      path: "/microgrids/[id]/operations",
      params: { id: "microgrid" },
      entity: "id",
      query: ["date"],
      attach: { to: "microgrid", order: 10, hint: "tab" },
      // Reads OpenEMS: refused while metering is off, and never polled. A
      // finished day does not change; today's partial day is refreshed by
      // the person, as on the page.
      cost: "vendor",
      declares: { keys: SITE_DAY_KEYS },
      ext: { schema: SITE_DAY_EXT_SCHEMA, zod: SiteDayExt },
      examples: SITE_DAY_EXAMPLES,
      load: loadSiteDay,
    },
  ],
  // All human-only: no assistant proposes a metering write. Each is
  // `targeted: false`, because no metering view offers it yet and another
  // plugin's view of the same entity (billing's periods, say, for a
  // microgrid) is no place to save a connection or register an edge. When
  // the setup pages move to views, their loaders link these.
  //
  // `repeat`: each "safe" action is sent twice to its route by
  // src/lib/gui/__tests__/repeat.db.test.ts (./repeat/metering.ts). The two
  // connection actions are "unsafe": each send runs a new check against the
  // backend and records its time (ems_last_discover_at, which the setup
  // pages show), and a save encrypts each credential entered again, so a
  // second send rewrites the row. If the routes stop recording the check on
  // an unchanged result, revisit.
  actions: [
    // A ceremony, as the route asks for the microgrid's name typed while it
    // has closed billing periods, and refuses while it has a draft one
    // (prepareSaveConnection). The ceremony names no credential: the four
    // are write-only in SaveConnectionBody, so no form or catalog carries a
    // value of theirs.
    {
      ...SAVE_CONNECTION_ACTION,
      target: "microgrid",
      input: SaveConnectionBody,
      inputVersion: SAVE_CONNECTION_BODY_VERSION,
      method: "PUT",
      path: "/api/microgrids/[id]/openems-backend",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "ceremony",
      humanOnly: true,
      repeat: "unsafe",
      targeted: false,
      prepare: prepareSaveConnection,
    },
    // Discover: checks the saved connection, records the result where the
    // metering.connection watcher reads it, and answers with the edges the
    // backend reports. An action because it writes that result; no
    // confirmation, as it changes nothing a person entered.
    {
      ...CHECK_CONNECTION_ACTION,
      target: "microgrid",
      input: CheckConnectionBody,
      inputVersion: CHECK_CONNECTION_BODY_VERSION,
      method: "POST",
      path: "/api/microgrids/[id]/openems-backend/discover",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      repeat: "unsafe",
      targeted: false,
    },
    {
      ...REGISTER_EDGES_ACTION,
      target: "microgrid",
      input: RegisterEdgesBody,
      inputVersion: REGISTER_EDGES_BODY_VERSION,
      method: "POST",
      path: "/api/microgrids/[id]/edges/register",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
    },
    {
      ...EDIT_EDGE_ACTION,
      target: "edge",
      input: EditEdgeBody,
      inputVersion: EDIT_EDGE_BODY_VERSION,
      method: "PATCH",
      path: "/api/edges/[id]",
      bind: { path: { id: "edge" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
    },
    // A DELETE: typed confirmation, the edge's name, from prepare.
    {
      ...DELETE_EDGE_ACTION,
      target: "edge",
      input: DeleteEdgeBody,
      inputVersion: DELETE_EDGE_BODY_VERSION,
      method: "DELETE",
      path: "/api/edges/[id]",
      bind: { path: { id: "edge" } },
      risk: "destructive",
      confirm: "typed",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
      prepare: prepareDeleteEdge,
    },
    {
      ...SAVE_DEVICES_ACTION,
      target: "edge",
      input: SaveDevicesBody,
      inputVersion: SAVE_DEVICES_BODY_VERSION,
      method: "POST",
      path: "/api/devices",
      bind: { body: { edgeId: "edge" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
    },
    {
      ...EDIT_DEVICE_ACTION,
      target: "device",
      input: EditDeviceBody,
      inputVersion: EDIT_DEVICE_BODY_VERSION,
      method: "PATCH",
      path: "/api/devices/[id]",
      bind: { path: { id: "device" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
    },
    // Money: the opening register is where a tenant's first bill starts
    // counting from. A one-step confirm with the form.
    {
      ...RECORD_OPENING_REGISTER_ACTION,
      target: "device",
      input: RecordOpeningRegisterBody,
      inputVersion: RECORD_OPENING_REGISTER_BODY_VERSION,
      method: "POST",
      path: "/api/meter-readings/opening",
      bind: { body: { device_id: "device" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
    },
  ],
  signals: [
    { id: CONNECTION_SIGNAL, load: loadConnectionSignals, examples: CONNECTION_EXAMPLES },
    // A cached backend read within its own budget (ADR-006 decision 9).
    { id: EDGE_STATUS_SIGNAL, budgetMs: EDGE_STATUS_BUDGET_MS, load: loadEdgeStatusSignals, examples: EDGE_STATUS_EXAMPLES },
  ],
};
