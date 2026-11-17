import { redirect } from "next/navigation";

/**
 * /accept-invite — where invitation emails used to land, to set a password.
 *
 * Invitations are now notices that point at /login (RFC #186 § 5): the
 * person signs in by email link, which also confirms the address, and has
 * no password to set. Links from earlier invitation emails still in
 * mailboxes come here and go on to sign-in. Their token is not used: the
 * redirect drops the URL's query and fragment.
 */
export default function AcceptInvitePage(): never {
  redirect("/login");
}
