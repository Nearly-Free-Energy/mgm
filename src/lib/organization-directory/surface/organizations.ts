import "server-only";

/**
 * The availability and confirmation steps of the organization directory's
 * organization actions: editing and deleting an organization
 * (org.update-organization, org.delete-organization) and saving and removing
 * its mail sender (org.save-email-sender, org.remove-email-sender). Every
 * read is through the person's own client, so a record they cannot read is
 * not found, and none reads the sender's password: the sender is read by
 * SENDER_PUBLIC_COLUMNS, which leaves it out, and the save's step names only
 * the caller's own address, where its test email goes.
 *
 * The delete's step refuses what its route refuses with the route's copy
 * (not a super admin, community management off, no name to type, billing the
 * database keeps), so the step is not offered for a delete the route would
 * refuse. None replaces the route's own refusal.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, SurfaceRequest } from "@/lib/gui/surface";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { SENDER_PUBLIC_COLUMNS, type OrganizationEmailSenderPublic } from "@/lib/email/organization-sender";
import { countEntityDescendants } from "@/lib/entity-descendants";
import type { DescendantCounts } from "@/lib/entity-descendants-types";
import { keptBillingCounts, keptBillingMessage } from "@/lib/entity-deletion/shared";
import { COMMUNITY_MANAGEMENT_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";

type Refusal = Extract<Loaded<never>, { ok: false }>;
type Input = { params: Record<string, string>; body?: unknown };

const unavailable = (what: string): Refusal => ({
  ok: false,
  status: 503,
  message: `Could not check the ${what} right now. Try again shortly.`,
});

/** PATCH /api/organizations/[id]'s copy for a caller who is not a super admin; if the route's changes, change this. */
export const UPDATE_NOT_SUPER_ADMIN = "Only super_admin users can update organizations.";

/**
 * org.update-organization's availability: a super admin's only, as its
 * route refuses everyone else (403), so an organization manager sees it
 * disabled with the route's reason rather than sending a refused write.
 * Read from the roles the host checked with getUser() for this request.
 */
export async function updateOrganizationAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const allowed = rolesIncludeSuperAdmin(req.roles);
  return Object.fromEntries(ids.map((id) => [id, allowed ? true : UPDATE_NOT_SUPER_ADMIN]));
}

/** DELETE /api/organizations/[id]'s copy, each as the route answers it; if the route's changes, change these. */
const DELETE_NOT_SUPER_ADMIN: Refusal = {
  ok: false,
  status: 403,
  message: "You do not have permission to delete this organization.",
};
const COMMUNITY_MANAGEMENT_OFF: Refusal = {
  ok: false,
  status: 409,
  message:
    "Community management is disabled for this organization. Enable it in Settings → Plugins before deleting; existing records are preserved.",
};
const UNNAMED: Refusal = { ok: false, status: 409, message: "Unnamed entity cannot be typed-to-confirm." };

/** The counts a person reads before typing the name, each a fact when it is not zero. */
const COUNTED: readonly [key: string, label: string][] = [
  ["communities", "Communities"],
  ["microgrids", "Microgrids"],
  ["edges", "Edges"],
  ["devices", "Devices"],
  ["tenants", "Tenants"],
  ["tenant_devices", "Tenant meter links"],
  ["tenant_access", "Tenant app access grants"],
  ["billing_periods_draft", "Draft billing periods"],
  ["billing_line_items", "Bills"],
  ["rate_schedules", "Rate schedules"],
  ["grid_tariffs", "Grid tariffs"],
  ["microgrid_savings_settings", "Savings settings"],
  ["user_roles", "Staff roles"],
];

/**
 * org.delete-organization's step: the organization, everything under it,
 * and its name to type, which the route checks again
 * (DeleteOrganizationBody). Refused, before anything is read, to anyone but
 * a super admin, as the route refuses them. The name shown and asked for is
 * the stored one trimmed, as community management's deletes ask for theirs
 * (../../community-management/surface/deletes.ts says why).
 */
export async function prepareDeleteOrganization(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  if (!rolesIncludeSuperAdmin(req.roles)) return DELETE_NOT_SUPER_ADMIN;
  const id = input.params.id;
  let enabled: boolean;
  try {
    // Asked so a state that cannot be read is a 503 here; the route reads it as off (409).
    enabled = await isPluginEnabledForOrg(req.supabase, id, COMMUNITY_MANAGEMENT_PLUGIN_NAME);
  } catch {
    return unavailable("organization");
  }
  if (!enabled) return COMMUNITY_MANAGEMENT_OFF;

  const { data: row, error } = await req.supabase
    .from("organizations")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) return unavailable("organization");
  if (!row) return { ok: false, status: 404, message: "This organization could not be found." };
  const name = row.name?.trim() || null;
  if (name === null) return UNNAMED;

  let counts: DescendantCounts;
  try {
    counts = await countEntityDescendants(req.supabase, "organization", id);
  } catch {
    return unavailable("organization");
  }
  const kept = keptBillingCounts(counts);
  if (kept) return { ok: false, status: 409, message: keptBillingMessage("organization", kept) };

  const values = counts as unknown as Record<string, unknown>;
  const facts: Ceremony["facts"] = [
    { label: "Organization", value: req.fmt.text(name) },
    ...COUNTED.flatMap(([key, label]) => {
      const n = values[key];
      return typeof n === "number" && n > 0 ? [{ label, value: req.fmt.number(n) }] : [];
    }),
  ];
  const drafts = counts.kind === "organization" ? counts.billing_periods_draft : 0;
  const warnings = [
    "Its staff roles go with it, so a person whose only role is here loses access.",
    ...(drafts === 0
      ? []
      : [drafts === 1
          ? "Its draft billing period is deleted too, with its readings and bills."
          : `Its ${drafts} draft billing periods are deleted too, with their readings and bills.`]),
  ];
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Delete the organization ${name} and everything in it. This cannot be undone.`,
      facts,
      warnings,
      acknowledgements: [],
      typed: name,
    },
  };
}

/**
 * PUT …/email-sender's copy for an account with no address; if the route's
 * changes, change this. The route answers it 422, which a step's refusal
 * cannot carry (Loaded), so the step answers 409.
 */
const NO_ADDRESS: Refusal = { ok: false, status: 409, message: "Your account has no email address to send the test to." };

/**
 * org.save-email-sender's step, an external action's: who the test email
 * goes to and through what. It goes to the caller's own address, through
 * the server the person enters, and the settings are saved only if that
 * server accepts it. The host gives prepare the form's starting values with
 * the password removed (writeOnly), so a server named there is shown; the
 * password never is.
 */
export async function prepareSaveEmailSender(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const to = req.user.email;
  if (!to) return NO_ADDRESS;
  const { data: organization, error } = await req.supabase
    .from("organizations")
    .select("id, name")
    .eq("id", input.params.id)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) return unavailable("organization");
  if (!organization) return { ok: false, status: 404, message: "This organization could not be found." };
  const body = (input.body ?? {}) as Record<string, unknown>;
  const host = typeof body.host === "string" && body.host.trim() ? body.host.trim() : null;
  const facts: Ceremony["facts"] = [
    { label: "Organization", value: req.fmt.text(organization.name?.trim() || "This organization") },
    { label: "Test email to", value: req.fmt.text(to) },
  ];
  if (host) facts.push({ label: "Mail server", value: req.fmt.text(host) });
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `MGM sends a test email to ${to} through the mail server you enter, and saves these settings only if the server accepts it.`,
      facts,
      warnings: [
        "Once saved, this organization's notices, such as invitations, go through this server. Sign-in links never do.",
      ],
      acknowledgements: [],
    },
  };
}

/**
 * org.remove-email-sender's step: the saved server, and its name to type,
 * which the route checks again (RemoveEmailSenderBody). Refused when no
 * sender is saved, as there is nothing to remove.
 */
export async function prepareRemoveEmailSender(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const { data: sender, error } = await req.supabase
    .from("organization_email_senders")
    .select(SENDER_PUBLIC_COLUMNS)
    .eq("org_id", input.params.id)
    .maybeSingle<OrganizationEmailSenderPublic>();
  if (error) return unavailable("email settings");
  if (!sender) return { ok: false, status: 404, message: "No email settings are saved for this organization." };
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Remove the mail server ${sender.host} from this organization's email settings.`,
      facts: [
        { label: "Mail server", value: req.fmt.text(sender.host) },
        { label: "From address", value: req.fmt.text(sender.from_address) },
      ],
      warnings: ["Notices then go through MGM's own mail server. The saved password is deleted."],
      acknowledgements: [],
      typed: sender.host,
    },
  };
}
