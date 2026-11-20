import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { computeAssignmentGaps } from "@/lib/metering/assignment-gaps";
import { TenantMeterSection } from "./tenant-meter-section";
import { TenantBillingTable, type BillingLineItemRow } from "./tenant-billing-table";
import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";

// Setup > Tenants > [tenantId] — Tenant detail page (D3 / #54).
//
// Renders: tenant basics, portal users count (tenant role rows), linked devices table,
// billing history (last 3 closed periods).
//
// Single stacked layout — no sub-tabs (confirmed design decision).
// HierarchyNav is out-of-scope (D4 / #55 owns placement).
// Editing tenant fields is deferred to a future ticket.

// ── Types ─────────────────────────────────────────────────────────────────────

type DeviceRow = {
  id: string;
  name: string;
  device_type: string;
  edges: { id: string; name: string } | null;
};

type TenantDeviceRow = {
  role: string;
  devices: DeviceRow | null;
};

type TenantRow = {
  id: string;
  display_name: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  unit_label: string | null;
  tenant_devices: TenantDeviceRow[];
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string; tenantId: string }>;
}) {
  await keepTenantOnlyToTenantPages();
  const { id: microgridId, tenantId } = await params;
  const supabase = await createClient();

  // Query 1 — tenant basics + linked devices (single round-trip).
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select(
      `id, display_name, primary_phone, primary_email,
       address_line1, address_line2, unit_label,
       tenant_devices(role, devices(id, name, device_type, edges(id, name)))`,
    )
    .eq("id", tenantId)
    .eq("microgrid_id", microgridId)
    .maybeSingle<TenantRow>();

  if (tenantError) {
    // #300: previously a query/embed error (RLS on the devices/edges embed, or a
    // relationship-resolution failure) was masked as a 404 by folding it into
    // notFound(). Surface it — log structured + throw — so the real PostgREST
    // error is visible (dev overlay / prod 500 + logs) instead of a misleading
    // "not found." A genuinely-missing tenant still 404s via the !tenant
    // branch below (maybeSingle returns null, not an error, for 0 rows).
    console.error(
      JSON.stringify({
        event: "tenant_detail.query_error",
        tenantId,
        microgridId,
        code: tenantError.code,
        message: tenantError.message,
        details: tenantError.details,
        hint: tenantError.hint,
        at: new Date().toISOString(),
      }),
    );
    throw new Error(
      `Failed to load tenant ${tenantId}: ${tenantError.message}`,
    );
  }

  if (!tenant) {
    notFound();
  }

  // Query 2 — portal users count: the people who can sign in to this
  // tenant's data, one tenant role row each (RFC mgm#197). Read through
  // fn_tenant_access_list because user_roles RLS shows a manager only their
  // own rows; a caller the function refuses sees 0.
  const { data: portalUsers } = await supabase.rpc("fn_tenant_access_list", {
    _tenant_id: tenantId,
  });
  const portalUserCount = portalUsers?.length ?? 0;

  // Query 3 — last 3 closed billing periods' line items for this tenant.
  const { data: lineItems } = await supabase
    .from("billing_line_items")
    .select(
      `usage_kwh, total_amount,
       billing_periods!inner(id, start_date, end_date, status)`,
    )
    .eq("tenant_id", tenantId)
    .eq("billing_periods.status", "closed")
    .order("billing_periods(end_date)", { ascending: false })
    .limit(3)
    .returns<BillingLineItemRow[]>();
  // Query 4 — effective-dated primary assignment history (issue #4) with
  // device names, plus whether the current meter has any readings (for the
  // opening-register affordance).
  const { data: primaryLinks } = await supabase
    .from("tenant_devices")
    .select("device_id, effective_from, effective_to, devices(id, name)")
    .eq("tenant_id", tenantId)
    .eq("role", "primary_consumption_meter")
    .order("effective_from", { ascending: true })
    .returns<
      {
        device_id: string;
        effective_from: string;
        effective_to: string | null;
        devices: { id: string; name: string } | null;
      }[]
    >();
  const { sorted: assignmentLinks, gaps: assignmentGaps } =
    computeAssignmentGaps(
      (primaryLinks ?? []).map((link) => ({
        deviceId: link.device_id,
        deviceName: link.devices?.name ?? link.device_id,
        effectiveFrom: link.effective_from,
        effectiveTo: link.effective_to,
      }))
    );
  const currentLink = [...assignmentLinks]
    .reverse()
    .find((link) => link.effectiveTo === null)
    ?? null;
  let currentMeterHasReadings = false;
  if (currentLink) {
    const { count: readingCount } = await supabase
      .from("meter_readings")
      .select("id", { count: "exact", head: true })
      .eq("device_id", currentLink.deviceId);
    currentMeterHasReadings = (readingCount ?? 0) > 0;
  }

  const devices = tenant.tenant_devices ?? [];
  const closedLineItems = (lineItems ?? []).filter(
    (li) => li.billing_periods?.status === "closed",
  );

  // Microgrid timezone for the opening-register dialog (issue #4): the
  // operator's wall-clock input is resolved in this zone, never the
  // browser's. Falls back to UTC when unreadable.
  const { data: microgridRow } = await supabase
    .from("microgrids")
    .select("timezone")
    .eq("id", microgridId)
    .maybeSingle<{ timezone: string }>();
  const microgridTimezone = microgridRow?.timezone ?? "UTC";

  // Resolve role + available unlinked consumption meters for P7 empty state (#139).
  const canManage = await currentUserCanAccessMicrogrid(supabase, microgridId);

  // Count unlinked consumption meters on this microgrid (sequential queries kept
  // simple to avoid dynamic .not("id","in",...) edge cases with empty arrays).
  const [edgesResult, assignedResult] = await Promise.all([
    supabase.from("edges").select("id").eq("microgrid_id", microgridId),
    supabase
      .from("tenant_devices")
      .select("device_id")
      .eq("role", "primary_consumption_meter")
      // Open links only: closed replacement history must not reserve the
      // device (issue #4).
      .is("effective_to", null),
  ]);
  const microgridEdgeIds = (edgesResult.data ?? []).map((e) => e.id);
  const assignedDeviceIds = (assignedResult.data ?? []).map((r) => r.device_id);

  let hasMetersAvailable = false;
  if (microgridEdgeIds.length > 0) {
    let metersQuery = supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .in("edge_id", microgridEdgeIds)
      .eq("device_type", "consumption_meter");

    if (assignedDeviceIds.length > 0) {
      metersQuery = metersQuery.not("id", "in", `(${assignedDeviceIds.join(",")})`);
    }

    const { count } = await metersQuery;
    hasMetersAvailable = (count ?? 0) > 0;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div>
        <Link
          href={`/microgrids/${microgridId}/setup/tenants`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to tenants
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h3 className="text-lg font-semibold text-foreground">
            {tenant.display_name ?? "Unnamed tenant"}
          </h3>
        </div>
      </div>

      {/* ── Section 1: Tenant basics ─────────────────────────────────────── */}
      <section aria-labelledby="basics-heading">
        <h4
          id="basics-heading"
          className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Tenant basics
        </h4>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <dl className="divide-y divide-border">
            <BasicRow label="Display name" value={tenant.display_name} />
            <BasicRow label="Phone" value={tenant.primary_phone} />
            <BasicRow label="Email" value={tenant.primary_email} />
            <BasicRow label="Address line 1" value={tenant.address_line1} />
            <BasicRow label="Address line 2" value={tenant.address_line2} />
            <BasicRow label="Unit label" value={tenant.unit_label} />
          </dl>
        </div>
      </section>

      {/* ── Section 2: Portal users ─────────────────────────────────────────── */}
      <section aria-labelledby="portal-users-heading">
        <h4
          id="portal-users-heading"
          className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Portal users
        </h4>
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground">
          {portalUserCount} portal user{portalUserCount === 1 ? "" : "s"} linked
        </div>
      </section>

      {/* ── Section 3: Linked devices ───────────────────────────────────────── */}
      <section aria-labelledby="devices-heading">
        <h4
          id="devices-heading"
          className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Linked devices
        </h4>
        {devices.length === 0 ? (
          <EmptyState
            tone="warn"
            eyebrow="Linked devices"
            title="Link this tenant to its meter"
            body={
              <>
                Pick a device from this microgrid&apos;s edges and mark it the
                primary consumption meter. Only tenants with a primary meter
                get billed.
              </>
            }
            secondary={
              canManage ? (
                <Link
                  href={`/microgrids/${microgridId}/setup/tenants`}
                  className="text-sm font-medium text-foreground underline hover:opacity-80"
                >
                  Go to Tenants listing →
                </Link>
              ) : undefined
            }
            footnote={
              !canManage
                ? `Ask a super admin to link a meter to ${tenant.display_name ?? "this tenant"}.`
                : hasMetersAvailable
                  ? "Go to Setup › Tenants and pick this tenant's primary meter from the row dropdown. A dedicated Link Device dialog is coming soon."
                  : "No unlinked consumption meters on this microgrid yet — run device discovery on an edge first."
            }
          />
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                    Device
                  </th>
                  <th className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                    Type
                  </th>
                  <th className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                    Role
                  </th>
                  <th className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                    Edge
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.map((hd, idx) => {
                  const device = hd.devices;
                  const isPrimary = hd.role === "primary_consumption_meter";
                  return (
                    <tr
                      key={device?.id ?? idx}
                      className={`border-t border-border${isPrimary ? " bg-warning-muted/30" : ""}`}
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {device?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        {device?.device_type ? (
                          <StatusChip
                            kind="deviceType"
                            status={device.device_type}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip
                          kind="tenantDeviceRole"
                          status={hd.role}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {device?.edges ? (
                          <Link
                            href={`/microgrids/${microgridId}/setup/edges/${device.edges.id}/`}
                            className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
                          >
                            {device.edges.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Section 4: Meter assignment history ─────────────────────────────── */}
      <TenantMeterSection
        entries={assignmentLinks.map((link, index, all) => ({
          deviceId: link.deviceId,
          deviceName: link.deviceName,
          role: "primary_consumption_meter",
          effectiveFrom: link.effectiveFrom,
          effectiveTo: link.effectiveTo,
          current:
            link.effectiveTo === null && index === all.length - 1,
        }))}
        gaps={assignmentGaps}
        hasReadings={currentMeterHasReadings}
        canManage={canManage}
        timezone={microgridTimezone}
      />

      {/* ── Section 5: Billing history ──────────────────────────────────────── */}
      <section aria-labelledby="billing-heading">
        <h4
          id="billing-heading"
          className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Billing history (last 3 closed periods)
        </h4>
        {closedLineItems.length === 0 ? (
          <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
            No billing history
          </p>
        ) : (
          <TenantBillingTable items={closedLineItems} />
        )}
      </section>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function BasicRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-3">
      <dt className="w-36 shrink-0 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{value ?? "—"}</dd>
    </div>
  );
}
