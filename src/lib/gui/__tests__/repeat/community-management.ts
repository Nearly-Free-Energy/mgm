/**
 * The twice-sent cases of community management's "safe" actions
 * (../repeat.db.test.ts), with their fixture: one organization with the
 * tenant app on, two communities, two microgrids (one to delete), an edge
 * with two consumption meters, and a tenant for each tenant case, one of
 * them linked to a meter since 1 January 2026 and one with a person's
 * access. Each case is sent as a manager of the organization, the person
 * the actions are offered to.
 *
 * community.create-community and community.create-tenant are "unsafe" (a
 * second send adds a second record), so they have no case here.
 *
 * Giving access sends its notice through sendNotice, which finds no sender
 * here (no MGM_SMTP_URL and no organization sender) and answers
 * email_sent: false; the test refuses any request that leaves the local
 * Supabase. If a sender comes to be configured in the test environment,
 * revisit.
 */
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { cleanupTestData, createTestUser, serviceClient } from "@/lib/supabase/__tests__/rls.helpers";
import type { CaseModule, Fixture } from "./harness";

const ORG = "e2780000-0000-4000-8000-000000000001";
const COMMUNITY = "e2780000-0000-4000-8001-000000000001";
const DOOMED_COMMUNITY = "e2780000-0000-4000-8001-000000000002";
const MG = "e2780000-0000-4000-8002-000000000001";
const DOOMED_MG = "e2780000-0000-4000-8002-000000000002";
const EDGE = "e2780000-0000-4000-8009-000000000001";
const FREE_METER = "e2780000-0000-4000-8007-000000000001";
const LINKED_METER = "e2780000-0000-4000-8007-000000000002";
const tenant = (n: number) => `e2780000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const EDITED = tenant(1);
const LINKING = tenant(2);
const UNLINKING = tenant(3);
const DOOMED_TENANT = tenant(4);
const GRANTING = tenant(5);
const REVOKING = tenant(6);
/** The revoked person's tenant row: the access id the removal's path names. */
const ACCESS = "e2780000-0000-4000-800a-000000000001";
const EMAILS = {
  manager: "repeat-cm-manager@test.local",
  /** The address the grant case gives access to; the route creates its account. */
  grantee: "repeat-cm-grantee@test.local",
  revokee: "repeat-cm-revokee@test.local",
};
const NAMES = {
  doomedCommunity: "Repeat CM Doomed Community",
  doomedMicrogrid: "Repeat CM Doomed Site",
  doomedTenant: "Repeat CM Doomed Tenant",
};

export const COMMUNITY_MANAGEMENT_CASES: CaseModule = {
  cases: {
    // The same fields again: 200, the community as it was.
    "community.update-community": [
      {
        as: "manager",
        params: { id: COMMUNITY },
        body: () => ({ name: "Repeat CM Community, renamed", address_city: "Jinja", geography_notes: null }),
        first: 200,
        second: 200,
      },
    ],
    // The community is gone, and with it the manager's way to it: 403. (A
    // super admin, who reaches every organization, gets 404.)
    "community.delete-community": [
      {
        as: "manager",
        params: { id: DOOMED_COMMUNITY },
        body: () => ({ confirmation: { acknowledged: [], typed: NAMES.doomedCommunity } }),
        first: 204,
        second: 403,
      },
    ],
    // The name is taken in that community now: 409 microgrid_duplicate_name.
    "community.create-microgrid": [
      {
        as: "manager",
        params: {},
        body: () => ({ community_id: COMMUNITY, name: "Repeat CM New Site", currency: "UGX", timezone: "Africa/Kampala", lat: "0.35" }),
        first: 201,
        second: 409,
      },
    ],
    // The same fields again: 200, the microgrid as it was.
    "community.update-microgrid": [
      {
        as: "manager",
        params: { id: MG },
        body: () => ({ address_city: "Mukono", timezone: "Africa/Nairobi", lat: "0.35", lng: 32.75 }),
        first: 200,
        second: 200,
      },
    ],
    // As for the community: 403 to a manager once it is gone.
    "community.delete-microgrid": [
      {
        as: "manager",
        params: { id: DOOMED_MG },
        body: () => ({ confirmation: { acknowledged: [], typed: NAMES.doomedMicrogrid } }),
        first: 204,
        second: 403,
      },
    ],
    "community.update-tenant": [
      // The same fields again: 200, the tenant as it was.
      {
        label: "fields",
        as: "manager",
        params: { id: EDITED },
        body: () => ({ display_name: "Repeat CM Tenant, renamed", primary_phone: "+256700278101", unit_label: "B2", account_number: null }),
        first: 200,
        second: 200,
      },
      // The meter is the tenant's open link now, which the route leaves as
      // it is rather than closing and opening it again: 200.
      {
        label: "links a meter",
        as: "manager",
        params: { id: LINKING },
        body: () => ({ device_id: FREE_METER }),
        first: 200,
        second: 200,
      },
      // The link is closed today; with no open link, there is nothing to
      // close: 200.
      {
        label: "unlinks a meter",
        as: "manager",
        params: { id: UNLINKING },
        body: () => ({ device_id: null }),
        first: 200,
        second: 200,
      },
    ],
    // The tenant is gone: 404.
    "community.delete-tenant": [
      {
        as: "manager",
        params: { id: DOOMED_TENANT },
        body: () => ({ confirmation: { acknowledged: [], typed: NAMES.doomedTenant } }),
        first: 204,
        second: 404,
      },
    ],
    // The address is on the unit's list now: 409 already_has_access, and no
    // second notice.
    "community.grant-tenant-access": [
      { as: "manager", params: { id: GRANTING }, body: () => ({ email: EMAILS.grantee }), first: 201, second: 409 },
    ],
    // The access is gone: 404 access_not_found.
    "community.revoke-tenant-access": [
      {
        as: "manager",
        params: { id: REVOKING, accessId: ACCESS },
        body: () => ({ confirmation: { acknowledged: [] } }),
        first: 204,
        second: 404,
      },
    ],
  },

  async cleanup() {
    const svc = await serviceClient();
    await svc.from("mgm_plugins").delete().eq("org_id", ORG);
    await cleanupTestData({ orgIds: [ORG], userEmails: Object.values(EMAILS) });
  },

  async seed(): Promise<Fixture> {
    const svc = await serviceClient();
    const unit = (id: string, n: number, name = `Repeat CM Tenant ${n}`) => ({
      id,
      microgrid_id: MG,
      display_name: name,
      primary_phone: `+256700278${String(n).padStart(3, "0")}`,
    });
    const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
      ["organizations", { id: ORG, name: "Repeat CM Org" }],
      ["mgm_plugins", { org_id: ORG, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }],
      [
        "communities",
        [
          { id: COMMUNITY, org_id: ORG, name: "Repeat CM Community", address_city: "Kampala" },
          { id: DOOMED_COMMUNITY, org_id: ORG, name: NAMES.doomedCommunity },
        ],
      ],
      [
        "microgrids",
        [
          { id: MG, community_id: COMMUNITY, name: "Repeat CM Site", currency: "UGX", timezone: "Africa/Kampala" },
          { id: DOOMED_MG, community_id: COMMUNITY, name: NAMES.doomedMicrogrid, currency: "UGX", timezone: "Africa/Kampala" },
        ],
      ],
      ["edges", { id: EDGE, microgrid_id: MG, name: "Repeat CM edge", openems_edge_id: "repeat-cm-edge" }],
      [
        "devices",
        [
          { id: FREE_METER, edge_id: EDGE, name: "Meter 1", device_type: "consumption_meter", openems_component_id: "meter1" },
          { id: LINKED_METER, edge_id: EDGE, name: "Meter 2", device_type: "consumption_meter", openems_component_id: "meter2" },
        ],
      ],
      [
        "tenants",
        [
          unit(EDITED, 1),
          unit(LINKING, 2),
          unit(UNLINKING, 3),
          unit(DOOMED_TENANT, 4, NAMES.doomedTenant),
          unit(GRANTING, 5),
          unit(REVOKING, 6),
        ],
      ],
      ["tenant_devices", { tenant_id: UNLINKING, device_id: LINKED_METER, role: "primary_consumption_meter", effective_from: "2026-01-01" }],
    ];
    for (const [table, value] of rows) {
      const { error } = await svc.from(table).insert(value);
      if (error) throw new Error(`[repeat community-management] ${table}: ${error.message}`);
    }
    const revokee = await createTestUser({ email: EMAILS.revokee, role: null });
    const { error } = await svc
      .from("user_roles")
      .insert({ id: ACCESS, user_id: revokee.userId, role: "tenant", scope_type: "tenant", scope_id: REVOKING });
    if (error) throw new Error(`[repeat community-management] user_roles: ${error.message}`);
    return {
      orgId: ORG,
      users: { manager: await createTestUser({ email: EMAILS.manager, role: "org_manager", scopeId: ORG }) },
    };
  },
};
