import "server-only";

/**
 * The organization directory's actions on people: how the host finds the
 * organization of one person (the `org.user` entity kind the user routes'
 * paths name), and the availability and confirmation steps of inviting,
 * resending an invitation, changing a role, editing a profile and removing
 * a person's staff access.
 *
 * Who may learn about whom. Every read of a person is through the caller's
 * own client and fn_list_visible_users, the function the Users page lists
 * people with: it shows a person, with their address and organization role,
 * only to the person themselves, a super admin, or a manager of an
 * organization the person holds a role in (user_can_see_user_profile), and
 * never shows an account whose rows are all tenant rows (RFC mgm#197). So
 * nothing here tells anyone an address or a role the Users page would not
 * show them. No step reads user_roles or auth.users directly, and nothing
 * here uses the service role. The invitation's step never looks up the
 * address being invited: whether an address has an account is answered by
 * the route alone, after its own checks.
 *
 * A person resolves to an organization only through an organization manager
 * row, its organization (userOrganization). A super admin, whose row names
 * none, and an account with no row are not found, so these actions do not
 * reach them through the host; the Users page still does. If the host comes
 * to take actions with no organization, revisit userOrganization.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { InstallationRequest, Loaded, SurfaceRequest } from "@/lib/gui/surface";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN, TENANT } from "@/lib/roles";

type Refusal = Extract<Loaded<never>, { ok: false }>;
type Input = { params: Record<string, string>; body?: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE: Refusal = { ok: false, status: 503, message: "Could not check this person right now. Try again shortly." };
const NOT_FOUND: Refusal = { ok: false, status: 404, message: "This person could not be found." };

/** A row of fn_list_visible_users, as its generated type gives it; only the columns read here. */
type Listed = {
  user_id: string;
  email: string | null;
  email_confirmed_at: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  scope_type: string | null;
  scope_id: string | null;
};

/**
 * The person as fn_list_visible_users lists them to the caller, or null when
 * it does not: not found, not visible, or (read as not listed, as the
 * resend route reads it) a tenant role, which the function does not return.
 * Throws when the list cannot be read.
 */
async function listedPerson(req: Pick<SurfaceRequest, "supabase">, id: string): Promise<Listed | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await req.supabase.rpc("fn_list_visible_users", { _target_user_ids: [id] });
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as Listed[]).find((r) => r.user_id === id);
  return row && row.role !== TENANT ? row : null;
}

/** The person's listing, or a refusal: 503 when the list cannot be read, 404 when they are not on it. */
async function person(req: SurfaceRequest, id: string): Promise<Listed | Refusal> {
  try {
    return (await listedPerson(req, id)) ?? NOT_FOUND;
  } catch {
    return UNAVAILABLE;
  }
}
const refused = (x: Listed | Refusal): x is Refusal => "ok" in x;

/**
 * The organization of one person, for the `org.user` entity kind: the
 * organization of their organization manager row, as fn_list_visible_users
 * lists it to the caller, or null. The host then checks that the caller's
 * own roles reach that organization (resolveSegments in
 * src/lib/gui/host/server/entities.ts), so a manager reaches the people of
 * their own organization and a super admin every organization manager. A
 * person the caller cannot see, a super admin (whose row names no
 * organization), an account with no row and an account whose rows are all
 * tenant rows are all null, which the host answers with the same 404 as an
 * id that names no one.
 *
 * The function lists at most one organization row per person, which
 * fn_change_user_role and fn_finalize_user_invitation keep true; if a person
 * can hold two, this resolves only the one it lists.
 */
export async function userOrganization(req: InstallationRequest, userId: string): Promise<string | null> {
  const row = await listedPerson(req, userId);
  if (!row || row.role !== ORG_MANAGER || row.scope_type !== SCOPE_ORG || !row.scope_id) return null;
  return row.scope_id;
}

const roleLabel = (role: string | null) =>
  role === SUPER_ADMIN ? "Super admin" : role === ORG_MANAGER ? "Org manager" : "No role";
const nameOf = (row: Listed) => [row.first_name, row.last_name].filter((part) => part?.trim()).join(" ");

async function organizationName(req: SurfaceRequest, id: string): Promise<string | null | "unavailable"> {
  const { data, error } = await req.supabase
    .from("organizations")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string | null }>();
  if (error) return "unavailable";
  return data ? data.name?.trim() || "This organization" : null;
}

/** Facts naming a person: their name when they have one, and their address. */
function personFacts(req: SurfaceRequest, row: Listed): Ceremony["facts"] {
  const name = nameOf(row);
  return [
    ...(name ? [{ label: "Name", value: req.fmt.text(name) }] : []),
    { label: "Email address", value: req.fmt.text(row.email ?? "") },
  ];
}

// ── Inviting ──

/**
 * org.invite-user's step, an external action's: the route may create an
 * account for the address and emails it a notice. It runs before the
 * address is typed and never reads it, so it names the organization the
 * action is offered in and says what is sent, in words. Whether the address
 * already has an account is the route's to answer.
 */
export async function prepareInviteUser(req: SurfaceRequest): Promise<Loaded<Ceremony>> {
  const name = await organizationName(req, req.organizationId);
  if (name === "unavailable") return { ok: false, status: 503, message: "Could not check the organization right now. Try again shortly." };
  if (name === null) return { ok: false, status: 404, message: "This organization could not be found." };
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement:
        "MGM gives the address you enter the role you choose and emails it an invitation. The email carries no sign-in link: they sign in from the sign-in page.",
      facts: [{ label: "Organization", value: req.fmt.text(name) }],
      warnings: [
        "An address with no MGM account gets one, with no password.",
        "An organization manager is invited to this organization. A super admin, whom only a super admin can invite, reaches every organization.",
      ],
      acknowledgements: [],
    },
  };
}

// ── Resending an invitation ──

/** POST /api/users/[id]/resend-invite's copy for an accepted invitation; if the route's changes, change this. */
const ACCEPTED: Refusal = { ok: false, status: 409, message: "User has already accepted their invitation." };

/**
 * org.resend-invite's step: the address the invitation goes to again, which
 * the caller already sees on the Users page. Refused once the person has
 * signed in, as the route refuses it.
 */
export async function prepareResendInvite(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  const row = await person(req, input.params.id);
  if (refused(row)) return row;
  if (!row.email) return NOT_FOUND;
  if (row.email_confirmed_at !== null) return ACCEPTED;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `MGM emails ${row.email} the invitation again. It carries no sign-in link: they sign in from the sign-in page.`,
      facts: personFacts(req, row),
      warnings: [],
      acknowledgements: [],
    },
  };
}

// ── Changing a role ──

/** fn_change_user_role's copy for each refusal its step repeats; if the function's changes, change these. */
const NOT_SUPER_ADMIN: Refusal = { ok: false, status: 403, message: "Only super admins can change roles." };
const SELF: Refusal = { ok: false, status: 403, message: "Cannot revoke your own access. Ask another administrator." };

/**
 * org.change-role's step, a ceremony with nothing to tick or type, as the
 * Users page asks only to save: the person, their role now and, when the
 * form starts from one, the role asked for. Refused to anyone but a super
 * admin before the person is read, as fn_change_user_role refuses them, so
 * no one else learns anything from it; and refused for the caller
 * themselves, which the function also refuses. Everything the change does
 * is the function's: this step changes no rule (CLAUDE.md, "Role
 * constants").
 */
export async function prepareChangeRole(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  if (!rolesIncludeSuperAdmin(req.roles)) return NOT_SUPER_ADMIN;
  const id = input.params.id;
  // Defensive: a super admin's own id does not resolve (userOrganization),
  // so the host answers 404 before this runs. Kept so the step still
  // refuses as fn_change_user_role does if super admins come to resolve.
  if (id.toLowerCase() === req.user.id.toLowerCase()) return SELF;
  const row = await person(req, id);
  if (refused(row)) return row;
  const current = row.scope_id ? await organizationName(req, row.scope_id) : null;
  if (current === "unavailable") return UNAVAILABLE;
  const facts: Ceremony["facts"] = [
    ...personFacts(req, row),
    { label: "Role now", value: req.fmt.text(current ? `${roleLabel(row.role)}, ${current}` : roleLabel(row.role)) },
  ];
  const body = (input.body ?? {}) as Record<string, unknown>;
  if (body.role === SUPER_ADMIN) facts.push({ label: "New role", value: req.fmt.text(roleLabel(SUPER_ADMIN)) });
  else if (body.role === ORG_MANAGER && typeof body.scope_id === "string" && UUID_RE.test(body.scope_id)) {
    const next = await organizationName(req, body.scope_id);
    if (next === "unavailable") return UNAVAILABLE;
    facts.push({ label: "New role", value: req.fmt.text(next ? `${roleLabel(ORG_MANAGER)}, ${next}` : roleLabel(ORG_MANAGER)) });
  }
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Change ${row.email ?? "this person"}'s role. Their organization role now is replaced by the one you choose.`,
      facts,
      warnings: [
        "A super admin can see and change every organization. An org manager reaches only their own.",
        "Access they have to a unit they rent is not changed.",
      ],
      acknowledgements: [],
    },
  };
}

// ── Editing a profile ──

/**
 * PATCH /api/users/[id]/profile's copy for a caller who may not edit the
 * profile: it answers 403 with it when the update policy raises 42501, or
 * when the update changed no row and the caller is neither the person nor
 * a super admin. If the route's changes, change this.
 */
export const PROFILE_NOT_YOURS = "Not authorized to update this profile.";

/**
 * org.update-profile's availability: a person edits their own profile, and
 * a super admin anyone's, as the user_profiles update policy allows
 * (00012_user_profiles.sql). Anyone else would get a refusal from the
 * route, so the action shows disabled with the route's reason. Read from the
 * caller's id and the roles the host checked with getUser() for this
 * request; nothing about the person is read.
 */
export async function updateProfileAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const superAdmin = rolesIncludeSuperAdmin(req.roles);
  const self = req.user.id.toLowerCase();
  return Object.fromEntries(ids.map((id) => [id, superAdmin || id.toLowerCase() === self ? true : PROFILE_NOT_YOURS]));
}

// ── Removing staff access ──

/** DELETE /api/users/[id]'s single refusal (notRevoked); if the route's changes, change this. */
const NOT_REVOKED: Refusal = { ok: false, status: 403, message: "No roles revoked (not authorized, or user has no roles)." };

/**
 * org.remove-user's step: the person losing their staff access, and their
 * address to type, which the route checks again (RemoveUserBody). The
 * caller already sees that address on the Users page.
 *
 * Refused to anyone but a super admin before the person is read, with the
 * route's own 403. The route deletes with the caller's own client, and a
 * DELETE reaches only rows a SELECT policy shows: the user_roles SELECT
 * policies show an org manager only their own rows ("Users can view their
 * own roles", 00002_rls.sql), so the org-manager DELETE policy (00013)
 * matches no colleague's row and the route answers every manager 403. If an
 * org manager is ever given a SELECT policy on colleagues' rows, revisit
 * this refusal. Then refused for the caller themselves, as the delete guard
 * refuses it; that check is defensive while a super admin does not resolve
 * (userOrganization), since the host answers a super admin's own id 404
 * before this runs. The last super admin, which the guard also refuses,
 * cannot be reached here for the same reason.
 */
export async function prepareRemoveUser(req: SurfaceRequest, input: Input): Promise<Loaded<Ceremony>> {
  if (!rolesIncludeSuperAdmin(req.roles)) return NOT_REVOKED;
  const id = input.params.id;
  if (id.toLowerCase() === req.user.id.toLowerCase()) return SELF;
  const row = await person(req, id);
  if (refused(row)) return row;
  if (!row.email) return NOT_FOUND;
  const organization = row.scope_id ? await organizationName(req, row.scope_id) : null;
  if (organization === "unavailable") return UNAVAILABLE;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Remove ${row.email}'s access to MGM. They can be invited again later.`,
      facts: [
        ...personFacts(req, row),
        { label: "Role", value: req.fmt.text(organization ? `${roleLabel(row.role)}, ${organization}` : roleLabel(row.role)) },
      ],
      warnings: ["Their account and profile are kept. Access they have to a unit they rent is not changed."],
      acknowledgements: [],
      typed: row.email,
    },
  };
}
