import "server-only";

/**
 * What the organization directory contributes to GUIs
 * (src/lib/gui/surface.ts): Today (`org.today`), the home page on "/", and
 * navigation to its other pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id, as Today kept `org.today` from the
 * Dashboard it replaces.
 *
 * Today lists the organization's signals (./today-model.ts), which the host
 * collects for it (`takesSignals`), and other plugins attach tiles to it
 * (attach { to: { view: "org.today" }, hint: "tile" }). The catalog serves
 * "/" by this view (`servedBy: "view"`), so the host's catch-all renders it.
 *
 * Its write routes are described as actions (RFC #259 § 3), so the action
 * catalog lists them. Its pages are not views yet and keep calling the same
 * routes with their own forms and dialogs, so no view offers these actions
 * today: each is `targeted: false`, reached through the catalog and
 * prepare. Each route parses with the action's input (./schemas.ts),
 * refusing what it refused before it was described, with its own answers.
 * The organization directory is core, so the plugin gate never turns its
 * actions off.
 *
 * `org.user` is a person, by their account id, the id the user routes'
 * paths name; it resolves to the organization of their organization
 * manager row, through the Users page's own list (userOrganization in
 * ./surface/users.ts).
 */
import type { ActionDef, Contribution } from "@/lib/gui/surface";
import { ORGANIZATION_DIRECTORY_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  CHANGE_ROLE_BODY_VERSION,
  ChangeRoleBody,
  DELETE_ORGANIZATION_BODY_VERSION,
  DeleteOrganizationBody,
  INVITE_USER_BODY_VERSION,
  InviteUserBody,
  REMOVE_EMAIL_SENDER_BODY_VERSION,
  REMOVE_USER_BODY_VERSION,
  RESEND_INVITE_BODY_VERSION,
  RemoveEmailSenderBody,
  RemoveUserBody,
  ResendInviteBody,
  SAVE_EMAIL_SENDER_BODY_VERSION,
  SET_PLUGIN_BODY_VERSION,
  SaveEmailSenderBody,
  SetPluginBody,
  UPDATE_ORGANIZATION_BODY_VERSION,
  UPDATE_PROFILE_BODY_VERSION,
  UpdateOrganizationBody,
  UpdateProfileBody,
} from "./schemas";
import {
  prepareDeleteOrganization,
  prepareRemoveEmailSender,
  prepareSaveEmailSender,
  updateOrganizationAvailable,
} from "./surface/organizations";
import {
  prepareChangeRole,
  prepareInviteUser,
  prepareRemoveUser,
  prepareResendInvite,
  updateProfileAvailable,
  userOrganization,
} from "./surface/users";
import { loadToday } from "./today";
import { TODAY_EXAMPLES } from "./today-examples";
import { TODAY_KEYS, TODAY_TITLE, TODAY_VIEW } from "./today-model";

/** A person, by account id: the id the user routes' paths name. */
export const USER_KIND = "org.user";

/** What every organization directory action shares: human-only, and offered only where a view links it. */
const SHARED = { humanOnly: true, targeted: false } as const;

/**
 * The actions. All human-only: they change who may do what, or where an
 * organization's email goes, and their steps name people and addresses,
 * which no assistant is shown. If one comes to be proposable, that is a
 * decision of its own (RFC #259 § 3).
 *
 * What a repeat does: every "safe" action is sent twice to its route by
 * src/lib/gui/__tests__/repeat.db.test.ts (./repeat/organization-directory.ts
 * there). Two are "unsafe": a resent invitation is a second email, and a
 * role change replaces the person's role row with a new one on every send
 * (fn_change_user_role), even with the role they hold; neither route is
 * changed to make a second send a no-op. If the twice-sent test fails for
 * an action, it is not safe.
 */
const ACTIONS: ActionDef[] = [
  // ── Organizations ──
  // A super admin's only (its route answers anyone else 403), which
  // available() reports, so an org manager sees it disabled with why. The
  // same fields again change nothing: organizations has no updated_at.
  {
    id: "org.update-organization",
    title: "Edit organization",
    target: "organization",
    input: UpdateOrganizationBody,
    inputVersion: UPDATE_ORGANIZATION_BODY_VERSION,
    method: "PATCH",
    path: "/api/organizations/[id]",
    bind: { path: { id: "organization" } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    available: updateOrganizationAvailable,
    ...SHARED,
  },
  // Typed, the organization's name, which the route requires. Everything
  // under it goes with it, so destructive. Refused by its prepare, not by
  // available(), to anyone but a super admin.
  {
    id: "org.delete-organization",
    title: "Delete organization",
    target: "organization",
    input: DeleteOrganizationBody,
    inputVersion: DELETE_ORGANIZATION_BODY_VERSION,
    method: "DELETE",
    path: "/api/organizations/[id]",
    bind: { path: { id: "organization" } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareDeleteOrganization,
    ...SHARED,
  },
  // External: the route sends a test email through the server entered, to
  // the caller's own address. A second identical send answers 409
  // version_conflict before it sends anything, because the first save moved
  // the version it names. If the route stops checking the version first,
  // revisit "safe".
  {
    id: "org.save-email-sender",
    title: "Save email settings",
    target: "organization",
    input: SaveEmailSenderBody,
    inputVersion: SAVE_EMAIL_SENDER_BODY_VERSION,
    method: "PUT",
    path: "/api/organizations/[id]/email-sender",
    bind: { path: { id: "organization" } },
    risk: "external",
    confirm: "confirm",
    repeat: "safe",
    prepare: prepareSaveEmailSender,
    ...SHARED,
  },
  // Typed, the saved server's name, which the route requires. Destructive:
  // the saved password goes, and only its owner can enter it again.
  {
    id: "org.remove-email-sender",
    title: "Remove email settings",
    target: "organization",
    input: RemoveEmailSenderBody,
    inputVersion: REMOVE_EMAIL_SENDER_BODY_VERSION,
    method: "DELETE",
    path: "/api/organizations/[id]/email-sender",
    bind: { path: { id: "organization" } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareRemoveEmailSender,
    ...SHARED,
  },
  // Confirm, as turning a plugin off hides its pages and refuses its
  // writes for the whole organization; nothing is deleted, so a write. The
  // same state again writes nothing (setOrganizationPluginEnabled).
  {
    id: "org.set-plugin",
    title: "Turn a plugin on or off",
    target: "organization",
    input: SetPluginBody,
    inputVersion: SET_PLUGIN_BODY_VERSION,
    method: "PATCH",
    path: "/api/organizations/[id]/plugins",
    bind: { path: { id: "organization" } },
    risk: "write",
    confirm: "confirm",
    repeat: "safe",
    ...SHARED,
  },

  // ── People ──
  // External: an account may be made, and a notice is emailed. The
  // organization is bound into scope_id, which the route reads for an
  // org_manager only. A second send for the same address answers 409
  // already_member before any notice, because the route reads the account's
  // rows first; two sends at once may both email. If the route stops
  // reading the rows first, revisit "safe".
  {
    id: "org.invite-user",
    title: "Invite user",
    target: "organization",
    input: InviteUserBody,
    inputVersion: INVITE_USER_BODY_VERSION,
    method: "POST",
    path: "/api/users/invite",
    bind: { body: { scope_id: "organization" } },
    risk: "external",
    confirm: "confirm",
    repeat: "safe",
    prepare: prepareInviteUser,
    ...SHARED,
  },
  // External and "unsafe": every send emails the invitation again (up to
  // the route's limit of 3 in 10 minutes) and writes no row.
  {
    id: "org.resend-invite",
    title: "Resend invitation",
    target: USER_KIND,
    input: ResendInviteBody,
    inputVersion: RESEND_INVITE_BODY_VERSION,
    method: "POST",
    path: "/api/users/[id]/resend-invite",
    bind: { path: { id: USER_KIND } },
    risk: "external",
    confirm: "confirm",
    repeat: "unsafe",
    prepare: prepareResendInvite,
    ...SHARED,
  },
  // A ceremony: a change of what someone may do. Write, not destructive: a
  // role can be changed back. "Unsafe": fn_change_user_role deletes the
  // person's organization row and inserts a new one on every send, so a
  // second send writes a new row; the route is not given a shortcut that
  // would change what the function decides.
  {
    id: "org.change-role",
    title: "Change role",
    target: USER_KIND,
    input: ChangeRoleBody,
    inputVersion: CHANGE_ROLE_BODY_VERSION,
    method: "PATCH",
    path: "/api/users/[id]/role",
    bind: { path: { id: USER_KIND } },
    risk: "write",
    confirm: "ceremony",
    repeat: "unsafe",
    prepare: prepareChangeRole,
    ...SHARED,
  },
  // One's own profile, or anyone's for a super admin (available()). The
  // same fields again write the same values; only updated_at moves.
  {
    id: "org.update-profile",
    title: "Edit profile",
    target: USER_KIND,
    input: UpdateProfileBody,
    inputVersion: UPDATE_PROFILE_BODY_VERSION,
    method: "PATCH",
    path: "/api/users/[id]/profile",
    bind: { path: { id: USER_KIND } },
    risk: "write",
    confirm: "none",
    repeat: "safe",
    available: updateProfileAvailable,
    ...SHARED,
  },
  // Typed, the person's address, which the route requires. Destructive: the
  // person loses their access at once. A second send finds no staff row:
  // 403. Prepared for a super admin only, as the route removes no one for
  // an org manager today (prepareRemoveUser says why).
  {
    id: "org.remove-user",
    title: "Revoke access",
    target: USER_KIND,
    input: RemoveUserBody,
    inputVersion: REMOVE_USER_BODY_VERSION,
    method: "DELETE",
    path: "/api/users/[id]",
    bind: { path: { id: USER_KIND } },
    risk: "destructive",
    confirm: "typed",
    repeat: "safe",
    prepare: prepareRemoveUser,
    ...SHARED,
  },
];

export const ORGANIZATION_DIRECTORY_SURFACE: Contribution = {
  plugin: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  nav: [
    { id: "org.today", title: TODAY_TITLE, icon: "today", group: "operate", order: 10, view: TODAY_VIEW },
    { id: "org.plugins", title: "Plugins", icon: "plugins", group: "system", order: 10, href: "/settings/plugins", needs: [], legacy: true },
    { id: "org.users", title: "Users", icon: "users", group: "system", order: 20, href: "/settings/users", needs: [], legacy: true },
    { id: "org.profile", title: "Profile", icon: "profile", group: "system", order: 30, href: "/settings/profile", needs: [], legacy: true },
    {
      id: "org.organizations",
      title: "Organizations",
      icon: "organizations",
      group: "system",
      order: 40,
      audience: "super-admin",
      href: "/organizations",
      needs: [],
      legacy: true,
    },
  ],
  views: [
    {
      id: TODAY_VIEW,
      kind: "collection",
      path: "/",
      params: {},
      // No `agent`: an assistant reads signals through their own route
      // when it comes (#133), not through the home page.
      // Reads nothing itself; the host collects the signals with the
      // person's own session, running each watcher only while its plugin is
      // on. The organization directory is core, so Today itself is never off.
      cost: "db",
      takesSignals: true,
      declares: { keys: TODAY_KEYS },
      examples: TODAY_EXAMPLES,
      load: loadToday,
    },
  ],
  actions: ACTIONS,
  entities: [{ kind: USER_KIND, organizationOf: userOrganization }],
};
