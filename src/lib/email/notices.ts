import "server-only";
/**
 * Notices: email MGM sends on an organization's behalf, such as an
 * invitation (RFC #186 § 5). A notice never carries a sign-in link, code or
 * token; sign-in mail goes only through the deployment's sender
 * (decision 5, src/lib/auth/sign-in-link.ts).
 *
 * Which server sends it:
 *   - an organization with a saved sender: that server;
 *   - an organization without one, or no organization (a super admin's
 *     invitation): the deployment's sender (decision 1);
 *   - when the organization's server fails: the failure is recorded on its
 *     saved settings, which the Email page shows, and the notice goes
 *     through the deployment's sender instead (decision 2). A later notice
 *     that gets through clears the flag.
 *
 * Runs on the service client after the caller's own access check: it reads
 * the saved sender and decrypts its password, bound to the row it read
 * (fn_organization_email_sender_password). Logs carry outcomes only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDeploymentSender } from "@/lib/config/mail-sender";
import { RuntimeConfigError } from "@/lib/config/public-runtime-config";
import type { MailMessage, MailSendResult, SmtpSenderSettings } from "@/lib/email/types";
import type { MailTransportRegistry } from "@/lib/runtime/services";

export type NoticeResult =
  | { ok: true; via: "organization" | "deployment" }
  | { ok: false; reason: string };

type SavedSender = {
  host: string;
  port: number;
  username: string;
  from_address: string;
  from_name: string | null;
  reply_to: string | null;
  version: number;
  last_test_status: string | null;
};

function log(outcome: string): void {
  console.info(JSON.stringify({ event: "email.notice", outcome }));
}

async function organizationSender(
  service: SupabaseClient,
  orgId: string
): Promise<{ row: SavedSender; settings: SmtpSenderSettings } | null> {
  const { data: row } = await service
    .from("organization_email_senders")
    .select("host, port, username, from_address, from_name, reply_to, version, last_test_status")
    .eq("org_id", orgId)
    .maybeSingle<SavedSender>();
  if (!row) return null;
  const { data: password } = await service.rpc("fn_organization_email_sender_password", {
    _org_id: orgId,
    _version: row.version,
    _host: row.host,
    _port: row.port,
    _username: row.username,
  });
  // Changed since the read: treat it as no sender for this notice.
  if (typeof password !== "string" || !password) return null;
  return {
    row,
    settings: {
      kind: "smtp",
      host: row.host,
      port: row.port,
      username: row.username,
      password,
      fromAddress: row.from_address,
      fromName: row.from_name,
      replyTo: row.reply_to,
    },
  };
}

/** Records the outcome of a notice on the saved settings, for the version that sent it. */
async function flag(service: SupabaseClient, orgId: string, row: SavedSender, sent: MailSendResult): Promise<void> {
  if (sent.ok && row.last_test_status === "success") return;
  await service
    .from("organization_email_senders")
    .update(
      sent.ok
        ? { last_tested_at: new Date().toISOString(), last_test_status: "success", last_test_message: "A notice was sent." }
        : {
            last_tested_at: new Date().toISOString(),
            last_test_status: sent.reason,
            last_test_message: `A notice could not be sent, so MGM's own mail server sent it. ${sent.message}`,
          }
    )
    .eq("org_id", orgId)
    .eq("version", row.version);
}

export async function sendNotice(input: {
  service: SupabaseClient;
  transports: MailTransportRegistry;
  orgId: string | null;
  message: MailMessage;
}): Promise<NoticeResult> {
  const { service, transports, orgId, message } = input;

  if (orgId) {
    const saved = await organizationSender(service, orgId);
    if (saved) {
      const sent = await transports.create(saved.settings).send(message);
      await flag(service, orgId, saved.row, sent);
      if (sent.ok) {
        log("sent_by_organization");
        return { ok: true, via: "organization" };
      }
      log(`organization_failed_${sent.reason}`);
    }
  }

  let deployment: SmtpSenderSettings;
  try {
    deployment = getDeploymentSender();
  } catch (error) {
    const detail = error instanceof RuntimeConfigError ? error.message : "deployment sender unavailable";
    console.error(JSON.stringify({ event: "email.notice", outcome: "not_configured", error: detail }));
    return { ok: false, reason: "not_configured" };
  }
  const sent = await transports.create(deployment).send(message);
  log(sent.ok ? "sent_by_deployment" : `deployment_failed_${sent.reason}`);
  return sent.ok ? { ok: true, via: "deployment" } : { ok: false, reason: sent.reason };
}
