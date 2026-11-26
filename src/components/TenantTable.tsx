"use client";

/**
 * TenantTable — list of tenants on a microgrid (#145 refactor).
 *
 * What this file does NOT do anymore:
 *   - No inline create form (TenantsSection wraps TenantWizard)
 *   - No inline name/phone/email edit (TenantEditDialog covers it)
 *   - No per-row inline billing-device <select> (TenantEditDialog covers
 *     it via DeviceSelect; superseded the #144 <optgroup> work)
 *
 * What this file DOES:
 *   - Renders one row per tenant with: stacked name + contact, address
 *     summary, click-to-edit billing-device chip, kebab menu
 *   - Kebab menu (Radix DropdownMenu, used directly per edge-row-actions
 *     pattern; no ui/dropdown-menu wrapper exists):
 *       Edit tenant           → opens TenantEditDialog
 *       Change/Link billing dev. → opens TenantEditDialog
 *       View detail →            → Link to detail page
 *       — separator —
 *       Delete tenant         → a typed <ConfirmDialog> asking for the
 *                                   tenant's name, then DELETE
 *                                   /api/tenants/[id] with that name as
 *                                   `{ confirmation: { acknowledged: [],
 *                                   typed } }`, which the route requires
 *                                   (428 without it), via the
 *                                   community-management capability
 *                                   (refuses tenants with billing history)
 *   - Click-to-edit chip column:
 *       Assigned   → <button> wrapping <Chip tone="success" dot>
 *       Unassigned → <button> wrapping <Chip tone="warn" dot>
 *     Real <button> + explicit aria-label so focus ring + keyboard
 *     activation come for free.
 *   - Address column: today's 3 fields joined; #146 widens.
 *
 * Permission: kebab + chip-button render only when canManage. For non-
 * managers the chip is a non-interactive <span>.
 *
 * BillingDeviceOption was added in #144 for the now-superseded native
 * <select>/<optgroup>. The shape carries the fields DeviceSelect needs
 * (edge_id, edge_name, linkedToTenantName) so it is reused as the prop
 * shape unchanged. Marking it deprecated would force callers to convert
 * shapes for no reason — leave the type in place as the public surface.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Device, Tenant } from "@/lib/types/domain";
import { Chip } from "@/components/ui/chip";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TenantEditDialog } from "@/components/forms/TenantEditDialog";

/**
 * An enriched device option for the billing-device picker. Carries
 * edge_id + edge_name (DeviceSelect groups by edge_id, labels with
 * edge_name) and an optional linkedToTenantName when the device is
 * already the primary_consumption_meter of a different tenant on this
 * microgrid.
 *
 * Originally introduced in #144 for the native <select>/<optgroup>. After
 * the #145 refactor the same shape feeds DeviceSelect — kept as the
 * canonical billing-device shape rather than renamed to avoid a churning
 * caller diff.
 */
export type BillingDeviceOption = {
  id: string;
  name: string;
  device_type: string;
  edge_id: string;
  edge_name: string;
  /** Set when this device is already assigned as primary_consumption_meter
   *  on a DIFFERENT tenant. DeviceSelect renders these greyed + disabled. */
  linkedToTenantName?: string | null;
};

interface Props {
  microgridId: string;
  tenants: Tenant[];
  /** Flat device list — used by the "current device" lookup in chip column. */
  devices: Device[];
  /** Enriched device list for the edit dialog's DeviceSelect. */
  billingDevices?: BillingDeviceOption[];
  /** tenant_id → device_id for primary_consumption_meter rows */
  primaryDeviceAssignments: Record<string, string>;
  canManage?: boolean;
  /** Called when the user clicks the "Add tenant" CTA in the empty state. */
  onAdd?: () => void;
  /** Edges discovery page href — surfaced in DeviceSelect's empty state. */
  microgridEdgesSetupHref?: string;
}

export function TenantTable({
  microgridId,
  tenants,
  devices,
  billingDevices,
  primaryDeviceAssignments,
  canManage = false,
  onAdd,
  microgridEdgesSetupHref,
}: Props) {
  const router = useRouter();

  // Edit dialog
  const [editing, setEditing] = React.useState<Tenant | null>(null);

  // Delete dialog
  const [tenantToDelete, setTenantToDelete] =
    React.useState<Tenant | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

  // Map of tenant_id → display_name (for DeviceSelect's "linked to"
  // suffix). Use this to enrich billingDevices on the fly.
  const tenantNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const h of tenants) m.set(h.id, h.display_name);
    return m;
  }, [tenants]);

  // device_id → owning tenant name (only for assigned devices that
  // belong to another tenant on this microgrid).
  const deviceLinkedTenantName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const [hhId, devId] of Object.entries(primaryDeviceAssignments)) {
      const name = tenantNameById.get(hhId);
      if (name) m.set(devId, name);
    }
    return m;
  }, [primaryDeviceAssignments, tenantNameById]);

  /**
   * Build the DeviceSelect prop list for THIS row. We rebuild rather than
   * passing a global list because the linked-elsewhere set depends on the
   * row's own currentDeviceId (the dialog component itself also strips
   * linked-to on the matching id, but doing it here keeps the prop list
   * small and deterministic per row).
   */
  function devicesForTenant(tenantId: string): BillingDeviceOption[] {
    const ownDeviceId = primaryDeviceAssignments[tenantId];
    const source =
      billingDevices ??
      // Fallback: derive a thin list from the flat `devices` prop. Edge
      // grouping degrades to a single "(unknown edge)" group when this
      // path is used. Callers should always pass `billingDevices`.
      devices.map<BillingDeviceOption>((d) => ({
        id: d.id,
        name: d.name,
        device_type: d.device_type,
        edge_id: d.edge_id,
        edge_name: "",
      }));

    return source.map((d) => {
      // The device that's CURRENTLY linked to this tenant must not
      // appear with a "linked to …" suffix in this row's picker.
      if (d.id === ownDeviceId) {
        return { ...d, linkedToTenantName: null };
      }
      // Devices linked to OTHER tenants get the suffix.
      const ownerName = deviceLinkedTenantName.get(d.id);
      if (ownerName) {
        return { ...d, linkedToTenantName: ownerName };
      }
      return { ...d, linkedToTenantName: null };
    });
  }

  function getDeviceForTenant(
    tenantId: string
  ): { name: string; edge_name: string } | null {
    const deviceId = primaryDeviceAssignments[tenantId];
    if (!deviceId) return null;
    const enriched = billingDevices?.find((d) => d.id === deviceId);
    if (enriched) {
      return { name: enriched.name, edge_name: enriched.edge_name };
    }
    const flat = devices.find((d) => d.id === deviceId);
    if (flat) {
      return { name: flat.name, edge_name: "" };
    }
    return null;
  }

  function addressSummary(h: Tenant): string {
    const parts = [h.address_city, h.address_region, h.address_country].filter(
      Boolean
    ) as string[];
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function openDeleteDialog(tenant: Tenant) {
    setTenantToDelete(tenant);
    setDeleteDialogOpen(true);
  }

  // The name the delete dialog asks for, and the route checks. The dialog
  // enables Confirm only once the input, trimmed, is this name.
  const nameToType = tenantToDelete?.display_name.trim() ?? "";

  async function handleDelete() {
    if (!tenantToDelete) return;
    const res = await fetch(`/api/tenants/${tenantToDelete.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: { acknowledged: [], typed: nameToType },
      }),
    });
    if (res.status === 204) {
      router.refresh();
      return;
    }
    let message = "Could not delete tenant.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // body wasn't JSON — use the default message.
    }
    throw new Error(message);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={tenantToDelete ? `Delete tenant “${nameToType}”?` : "Delete tenant?"}
        description={
          tenantToDelete
            ? `This cannot be undone. Its meter links and app access go with it. Type “${nameToType}” to confirm.`
            : undefined
        }
        confirmLabel="Delete tenant"
        tone="destructive"
        requireTypedConfirmation={{
          label: "Type tenant name to confirm",
          expected: nameToType,
        }}
        onConfirm={handleDelete}
      />

      {editing && (
        <TenantEditDialog
          open={Boolean(editing)}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          tenant={editing}
          availableDevices={devicesForTenant(editing.id)}
          currentDeviceId={primaryDeviceAssignments[editing.id] ?? null}
          edgesSetupHref={
            microgridEdgesSetupHref ??
            `/microgrids/${microgridId}/setup/edges`
          }
        />
      )}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Tenants</h2>
      </div>

      {tenants.length === 0 ? (
        <EmptyState
          eyebrow="Tenants"
          title="Add the first tenant"
          body={
            <>
              Tenants are the customers on this microgrid. Each gets their
              own bill. Add them now; link their meter later.
            </>
          }
          cta={
            canManage && onAdd ? (
              <button
                type="button"
                onClick={onAdd}
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                + Add tenant
              </button>
            ) : undefined
          }
          footnote={
            !canManage
              ? "Ask a super admin to add tenants for this microgrid."
              : undefined
          }
          className="border-0 shadow-none bg-transparent p-0"
        />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Tenants on this microgrid
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Tenant</th>
                {/* PDF3 (#205) — Account Number column between Tenant
                    and Address. Empty rows show "—" muted. */}
                <th className="pb-2 pr-4 font-medium">Account number</th>
                <th className="pb-2 pr-4 font-medium">Address</th>
                <th className="pb-2 pr-4 font-medium">Billing device</th>
                <th className="pb-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => {
                const device = getDeviceForTenant(tenant.id);
                return (
                  <tr
                    key={tenant.id}
                    className="border-b border-border align-top"
                  >
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {tenant.display_name}
                        </span>
                        {/* PDF3 (#205) — Customer Type chip next to display
                            name. Visually compact (no extra column). */}
                        <StatusChip
                          kind="tenantCustomerType"
                          status={tenant.customer_type}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[tenant.primary_email, tenant.primary_phone]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                    </td>
                    {/* PDF3 (#205) — Account Number column. */}
                    <td className="py-3 pr-4 text-muted-foreground">
                      {tenant.account_number ? (
                        <span className="text-foreground">
                          {tenant.account_number}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      <span className="block max-w-[260px] truncate">
                        {addressSummary(tenant)}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <BillingDeviceCell
                        tenant={tenant}
                        device={device}
                        canManage={canManage}
                        onEdit={() => setEditing(tenant)}
                      />
                    </td>
                    <td className="py-3 text-right">
                      {canManage ? (
                        <TenantRowActions
                          tenant={tenant}
                          microgridId={microgridId}
                          hasDevice={Boolean(device)}
                          onEdit={() => setEditing(tenant)}
                          onDelete={() => openDeleteDialog(tenant)}
                        />
                      ) : (
                        <Link
                          href={`/microgrids/${microgridId}/setup/tenants/${tenant.id}`}
                          className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Cell + actions ───────────────────────────────────────────────────────

function BillingDeviceCell({
  tenant,
  device,
  canManage,
  onEdit,
}: {
  tenant: Tenant;
  device: { name: string; edge_name: string } | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  if (!canManage) {
    if (device) {
      return (
        <Chip tone="success" dot>
          {device.name}
          {device.edge_name ? (
            <span className="ml-1 text-caption text-muted-foreground">
              · {device.edge_name}
            </span>
          ) : null}
        </Chip>
      );
    }
    // #158: an un-metered tenant is an intentional manual-billing state,
    // not a missing assignment. Render the canonical "No meter" status chip
    // so it reads as a configured (if non-automated) lifecycle state.
    return <StatusChip kind="meter" status="not_configured" />;
  }

  if (device) {
    return (
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Change billing device for ${tenant.display_name}`}
        className="inline-flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chip tone="success" dot>
          {device.name}
          {device.edge_name ? (
            <span className="ml-1 text-caption text-muted-foreground">
              · {device.edge_name}
            </span>
          ) : null}
        </Chip>
      </button>
    );
  }
  // #158: clickable "No meter" chip — opens the edit dialog so the operator
  // can link a meter retroactively if a physical install lands later.
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Link a billing device for ${tenant.display_name}`}
      className="inline-flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StatusChip kind="meter" status="not_configured" />
    </button>
  );
}

function TenantRowActions({
  tenant,
  microgridId,
  hasDevice,
  onEdit,
  onDelete,
}: {
  tenant: Tenant;
  microgridId: string;
  hasDevice: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${tenant.display_name}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <KebabIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-elev-2"
        >
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-dense text-foreground outline-none data-[highlighted]:bg-muted"
          >
            Edit tenant
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-dense text-foreground outline-none data-[highlighted]:bg-muted"
          >
            {hasDevice ? "Change billing device" : "Link device"}
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link
              href={`/microgrids/${microgridId}/setup/tenants/${tenant.id}`}
              className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-dense text-foreground outline-none data-[highlighted]:bg-muted"
            >
              View detail →
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={onDelete}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-dense text-destructive-fg outline-none data-[highlighted]:bg-destructive-muted"
          >
            Delete tenant
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function KebabIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <circle cx="8" cy="3" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="8" cy="13" r="1.25" />
    </svg>
  );
}
