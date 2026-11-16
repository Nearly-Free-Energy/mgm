/**
 * An organization's saved mail server (organization_email_senders, migration
 * 20261116210000): the columns a signed-in reader may see, and the test email
 * sent before settings are saved.
 *
 * The sender carries notices only, never a sign-in link or code (RFC #186
 * decision 5).
 */

/**
 * Every column `authenticated` may SELECT. The migration grants exactly these
 * columns, so a query naming `password_encrypted`, or `*`, is refused; a new
 * column is invisible until it is added both there and here.
 */
export const SENDER_PUBLIC_COLUMNS =
  "org_id, host, port, username, from_address, from_name, reply_to, version, last_tested_at, last_test_status, last_test_message, created_at, updated_at";

export type OrganizationEmailSenderPublic = {
  org_id: string;
  host: string;
  port: number;
  username: string;
  from_address: string;
  from_name: string | null;
  reply_to: string | null;
  version: number;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
};

export function testMessage(input: { to: string; organizationName: string }) {
  return {
    to: input.to,
    subject: `MGM test email for ${input.organizationName}`,
    text: [
      `This is a test email from MGM (Microgrid Manager).`,
      ``,
      `${input.organizationName} will send its notices, such as invitations, through this mail server.`,
      `MGM never sends sign-in links or codes through it.`,
      ``,
      `You received this because you saved these mail settings in MGM.`,
    ].join("\n"),
  };
}
