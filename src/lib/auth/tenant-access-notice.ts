import "server-only";
/**
 * The notice that someone can now sign in to see their unit's electricity
 * use (RFC mgm#197 § 6). Like the invitation (RFC #186 § 5) it is a notice,
 * not a credential: it says where to sign in and carries no link token or
 * code, and it names no unit, meter or figure. It goes through the tenant's
 * organization's sender, which never sends sign-in mail (RFC #186
 * decision 5); if a notice ever needs a sign-in link, it must go through
 * issueSignInLink instead, never through sendNotice.
 */
import { appUrl } from "@/lib/config/app-url";
import type { MailMessage } from "@/lib/email/types";

export function tenantAccessNotice(input: {
  to: string;
  organizationName: string | null;
}): MailMessage {
  const org = input.organizationName?.trim() || null;
  return {
    to: input.to,
    subject: org
      ? `${org} gave you access to your electricity use in MGM`
      : "You have access to your electricity use in MGM",
    text: [
      org
        ? `${org} gave you access to your electricity use in MGM (Microgrid Manager).`
        : "You were given access to your electricity use in MGM (Microgrid Manager).",
      "",
      `To sign in, go to ${appUrl("/login")} and choose "Email me a sign-in link" with this address, ${input.to}.`,
      "MGM emails you a link that signs you in. There is no password to set.",
      "",
      "If you were not expecting this, you can ignore this email.",
    ].join("\n"),
  };
}
