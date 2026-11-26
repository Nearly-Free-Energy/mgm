import "server-only";

/**
 * What community management contributes to GUIs (src/lib/gui/surface.ts):
 * navigation to its pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses, and its write
 * routes described as actions (RFC #259 § 3), so the action catalog lists
 * them. A page that moves to a view keeps its nav id.
 *
 * Its pages are not views yet, and keep calling the same routes with their
 * own forms and dialogs. So no view offers these actions today: each is
 * `targeted: false`, never appended to another plugin's view of its target
 * (a billing view of a microgrid would otherwise gain Edit and Delete
 * microgrid), and reached through the catalog and prepare. When a page
 * moves to a view, its loader links them.
 *
 * Each route parses with the action's input (./schemas.ts), refusing what
 * it refused before it was described, with its own answers.
 *
 * `community.tenant-access` is a tenant's access to its unit's pages, the
 * role row id the removal's path names; it resolves only beside the tenant
 * it belongs to (tenantAccessOrganization in ./surface/tenant-access.ts).
 */
import type { ActionDef, Contribution } from "@/lib/gui/surface";
import { COMMUNITY_MANAGEMENT_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  CREATE_COMMUNITY_BODY_VERSION,
  CREATE_MICROGRID_BODY_VERSION,
  CREATE_TENANT_BODY_VERSION,
  CreateCommunityBody,
  CreateMicrogridBody,
  CreateTenantBody,
  DELETE_COMMUNITY_BODY_VERSION,
  DELETE_MICROGRID_BODY_VERSION,
  DELETE_TENANT_BODY_VERSION,
  DeleteCommunityBody,
  DeleteMicrogridBody,
  DeleteTenantBody,
  REVOKE_TENANT_ACCESS_BODY_VERSION,
  RevokeTenantAccessBody,
  TENANT_ACCESS_GRANT_BODY_VERSION,
  TenantAccessGrantBody,
  UPDATE_COMMUNITY_BODY_VERSION,
  UPDATE_MICROGRID_BODY_VERSION,
  UPDATE_TENANT_BODY_VERSION,
  UpdateCommunityBody,
  UpdateMicrogridBody,
  UpdateTenantBody,
} from "./schemas";
import { prepareDeleteCommunity, prepareDeleteMicrogrid, prepareDeleteTenant } from "./surface/deletes";
import { prepareGrantTenantAccess, prepareRevokeTenantAccess, tenantAccessOrganization } from "./surface/tenant-access";

/** A tenant's access to its unit's pages: the role row id fn_tenant_access_list answers as `access_id`. */
export const TENANT_ACCESS_KIND = "community.tenant-access";

/** What every community management action shares: human-only, and offered only where a view links it. */
const SHARED = { humanOnly: true, targeted: false } as const;

/**
 * The actions. All human-only: no assistant proposes a change to an
 * organization's records, and this plugin has no view or watcher, so none
 * carries the assistant mark (ADR-007). If one of its views comes to be
 * marked, revisit each action's humanOnly. The tenant actions' steps name a
 * tenant and an address, which #133's data boundary keeps from any model.
 *
 * What a repeat does: every "safe" action is sent twice to its route by
 * src/lib/gui/__tests__/repeat.db.test.ts (./repeat/community-management.ts
 * there). The two creates that add a row on each send are "unsafe": nothing
 * makes a community's or a tenant's name unique, so a second send adds a
 * second record. If the twice-sent test fails for an action, it is not safe.
 */
const ACTIONS: ActionDef[] = [
  // ── Communities ──
  // Every send adds a community: names are not unique
  // (00010_entity_uniqueness.sql). If a migration makes them unique, a
  // second send is refused, and this can be "safe" with a twice-sent case.
  {
    id: "community.create-community",
    title: "Add community",
    target: "organization",
    input: CreateCommunityBody,
    inputVersion: CREATE_COMMUNITY_BODY_VERSION,
    method: "POST",
    path: "/api/communities",
    bind: { body: { org_id: "organization" } },
    risk: "write",
    confirm: "none",
    repeat: "unsafe",
    ...SHARED,
  },
  // Only the fields sent change; the same fields again change nothing.
  {
    id: "community.update-community",
    title: "Edit community",
    target: "community",
    input: UpdateCommunityBody,
    inputVersion: UPDATE_COMMUNITY_BODY_VERSION,
    method: "PATCH",
    path: "/api/communities/[id]",
    bind: { path: { id: "community" } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    ...SHARED,
  },
  // A DELETE: typed, the community's name, which the route requires. The
  // cascade takes its microgrids and everything under them, so destructive.
  {
    id: "community.delete-community",
    title: "Delete community",
    target: "community",
    input: DeleteCommunityBody,
    inputVersion: DELETE_COMMUNITY_BODY_VERSION,
    method: "DELETE",
    path: "/api/communities/[id]",
    bind: { path: { id: "community" } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareDeleteCommunity,
    ...SHARED,
  },

  // ── Microgrids ──
  // A second send is refused: a microgrid's name is unique in its community
  // (microgrids_community_name_unique). If a migration drops that
  // constraint, a second send adds a second microgrid: declare "unsafe".
  {
    id: "community.create-microgrid",
    title: "Add microgrid",
    target: "community",
    input: CreateMicrogridBody,
    inputVersion: CREATE_MICROGRID_BODY_VERSION,
    method: "POST",
    path: "/api/microgrids",
    bind: { body: { community_id: "community" } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    ...SHARED,
  },
  // Write, with no confirmation, as the microgrid's edit page (EntityForm)
  // sends it. Its currency and time zone reach billing differently. Bills
  // store no currency: every bill and invoice of the microgrid is shown in
  // the microgrid's, so the route refuses a currency change once any of its
  // periods is closed (409 microgrid_currency_locked); a change before
  // then relabels draft bills only. A period stamps its own time zone when
  // it is made (billing_periods.timezone), so a time zone change moves only
  // periods made after it. If the route stops refusing that change, it
  // relabels closed bills again, and this becomes money, with a step that
  // names the closed periods it relabels.
  {
    id: "community.update-microgrid",
    title: "Edit microgrid",
    target: "microgrid",
    input: UpdateMicrogridBody,
    inputVersion: UPDATE_MICROGRID_BODY_VERSION,
    method: "PATCH",
    path: "/api/microgrids/[id]",
    bind: { path: { id: "microgrid" } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    ...SHARED,
  },
  {
    id: "community.delete-microgrid",
    title: "Delete microgrid",
    target: "microgrid",
    input: DeleteMicrogridBody,
    inputVersion: DELETE_MICROGRID_BODY_VERSION,
    method: "DELETE",
    path: "/api/microgrids/[id]",
    bind: { path: { id: "microgrid" } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareDeleteMicrogrid,
    ...SHARED,
  },

  // ── Tenants ──
  // Without a meter, every send adds a tenant: names are not unique. (With
  // one, the second is refused, as the meter is then taken.) If tenants
  // gain a unique key a send repeats, revisit.
  {
    id: "community.create-tenant",
    title: "Add tenant",
    target: "microgrid",
    input: CreateTenantBody,
    inputVersion: CREATE_TENANT_BODY_VERSION,
    method: "POST",
    path: "/api/tenants/with-meter",
    bind: { body: { microgrid_id: "microgrid" } },
    risk: "write",
    confirm: "none",
    repeat: "unsafe",
    ...SHARED,
  },
  // Write, not money: a meter linked or unlinked here changes which readings
  // bill the tenant from today, and no bill already made. If the route comes
  // to change a bill, revisit.
  {
    id: "community.update-tenant",
    title: "Edit tenant",
    target: "tenant",
    input: UpdateTenantBody,
    inputVersion: UPDATE_TENANT_BODY_VERSION,
    method: "PATCH",
    path: "/api/tenants/[id]",
    bind: { path: { id: "tenant" } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    ...SHARED,
  },
  // Typed, as the tenants page's delete dialog is: a DELETE is typed or
  // ceremony, and the tenant's meter links and app access go with it. The
  // route requires the name (428 without it). A tenant with billing history
  // is refused (prepare and the route).
  {
    id: "community.delete-tenant",
    title: "Delete tenant",
    target: "tenant",
    input: DeleteTenantBody,
    inputVersion: DELETE_TENANT_BODY_VERSION,
    method: "DELETE",
    path: "/api/tenants/[id]",
    bind: { path: { id: "tenant" } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareDeleteTenant,
    ...SHARED,
  },

  // ── Tenant app access (RFC mgm#197 § 6) ──
  // External: the route emails the address a notice, through the
  // organization's sender. Prepare runs before the address is typed, so its
  // step says who in words, and refuses while the tenant app is off. A
  // second send for the same address answers 409 already_has_access and
  // sends no second notice, because the route reads the unit's access list
  // (fn_tenant_access_list) before it makes an account, grants or emails.
  // Two sends at once may both email (that route's step 4). If the route
  // stops reading the list first, revisit "safe".
  {
    id: "community.grant-tenant-access",
    title: "Give access",
    target: "tenant",
    input: TenantAccessGrantBody,
    inputVersion: TENANT_ACCESS_GRANT_BODY_VERSION,
    method: "POST",
    path: "/api/tenants/[id]/access",
    bind: { path: { id: "tenant" } },
    risk: "external",
    confirm: "confirm",
    repeat: "safe",
    prepare: prepareGrantTenantAccess,
    ...SHARED,
  },
  // A DELETE, so a ceremony: the address and the unit, with nothing to tick
  // or type, as the tenant page's Remove asks only to confirm. Write, not
  // destructive: access can be given again.
  {
    id: "community.revoke-tenant-access",
    title: "Remove access",
    target: "tenant",
    input: RevokeTenantAccessBody,
    inputVersion: REVOKE_TENANT_ACCESS_BODY_VERSION,
    method: "DELETE",
    path: "/api/tenants/[id]/access/[accessId]",
    bind: { path: { id: "tenant", accessId: TENANT_ACCESS_KIND } },
    risk: "write",
    confirm: "ceremony",
    repeat: "safe",
    prepare: prepareRevokeTenantAccess,
    ...SHARED,
  },
];

export const COMMUNITY_MANAGEMENT_SURFACE: Contribution = {
  plugin: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  nav: [
    { id: "community.microgrids", title: "Microgrids", icon: "sites", group: "operate", order: 20, href: "/microgrids", needs: [], legacy: true },
    { id: "community.communities", title: "Communities", icon: "communities", group: "operate", order: 30, href: "/communities", needs: [], legacy: true },
    {
      id: "community.tenants",
      title: "Tenants",
      icon: "tenants",
      group: "operate",
      order: 50,
      href: "/microgrids/[id]/setup/tenants",
      needs: ["microgrid"],
      legacy: true,
    },
  ],
  actions: ACTIONS,
  entities: [{ kind: TENANT_ACCESS_KIND, organizationOf: tenantAccessOrganization }],
};
