import "server-only";
/**
 * The invitation email (RFC #186 § 5). It is a notice, not a credential: it
 * says who gave the person access and where to sign in, and carries no
 * link token or code. The first sign-in by email link proves the person
 * controls the address, so an invitation never expires and leaves nothing
 * usable in a mailbox.
 */
import { appUrl } from "@/lib/config/app-url";
import type { InviteDataPayload } from "@/lib/auth/invite-data-payload";
import type { MailMessage } from "@/lib/email/types";

export function invitationNotice(input: { to: string; data: InviteDataPayload }): MailMessage {
  const { to, data } = input;
  const inviter = data.invited_by_name ?? "Someone";
  const where = data.org_name ? `${data.org_name} in MGM` : "MGM";
  return {
    to,
    subject: data.org_name ? `You have access to ${data.org_name} in MGM` : "You have access to MGM",
    text: [
      `${inviter} gave you access to ${where} (Microgrid Manager), as ${data.role_label}.`,
      "",
      `To sign in, go to ${appUrl("/login")} and choose "Email me a sign-in link" with this address, ${to}.`,
      "MGM emails you a link that signs you in. There is no password to set.",
      "",
      "If you were not expecting this, you can ignore this email.",
    ].join("\n"),
  };
}
