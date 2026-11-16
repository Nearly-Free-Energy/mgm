/**
 * /api/organizations/[id]/email-sender — the organization's mail server for
 * notices (RFC #186). It never sends sign-in links or codes (decision 5).
 *
 * GET — the saved sender, without its password, or null.
 *
 * PUT — test, then save. Sends a test email to the signed-in person through
 * the submitted settings; saves only when it was accepted.
 *   Body: { host, port, username, password?, fromAddress, fromName?,
 *           replyTo?, version }
 *   - password blank → keep the saved one, but only while host, port and
 *     username are unchanged (the database refuses otherwise, see the
 *     migration); the first save needs a password.
 *   - version is the one the form loaded (null before the first save); a
 *     different saved version answers 409 and nothing is sent.
 *   - When the test fails and the submitted settings are exactly the saved
 *     ones, the failure is recorded on the saved row, so the settings page
 *     shows that the saved server stopped working.
 *
 * DELETE — remove the sender. The organization's notices then go through
 * the deployment's sender (#186 decision 1).
 *
 * Access: currentUserCanAccessOrg (org managers of the organization and
 * super admins) answers 403 before the service client is used. The service
 * client decrypts the saved password and writes the row: `authenticated` has
 * no INSERT or UPDATE grant on the table.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { getMgmRuntime } from "@/lib/runtime/root";
import { parseSenderInput } from "@/lib/email/sender-input";
import { normalizeMailHost } from "@/lib/email/smtp/address";
import {
  SENDER_PUBLIC_COLUMNS,
  testMessage,
  type OrganizationEmailSenderPublic,
} from "@/lib/email/organization-sender";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

async function authorize(orgId: string) {
  if (!UUID_RE.test(orgId)) {
    return { response: NextResponse.json({ error: "Invalid organization id." }, { status: 400 }) };
  }
  const supabase = await createClient();
  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return { response: NextResponse.json({ error: "Not authorized." }, { status: 403 }) };
  }
  return { supabase };
}

export async function GET(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const { id: orgId } = await params;
  const { supabase, response } = await authorize(orgId);
  if (!supabase) return response;
  const { data, error } = await supabase
    .from("organization_email_senders")
    .select(SENDER_PUBLIC_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle<OrganizationEmailSenderPublic>();
  if (error) {
    return NextResponse.json({ error: "Could not read the email settings." }, { status: 500 });
  }
  return NextResponse.json({ sender: data ?? null });
}

export async function PUT(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const { id: orgId } = await params;
  const parsed = parseSenderInput(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 422 });
  }
  const input = parsed.value;
  const host = normalizeMailHost(input.host);
  if (!host) {
    return NextResponse.json(
      { error: "Enter the mail server's name, for example smtp.example.com, not an address.", field: "host" },
      { status: 422 }
    );
  }

  const { supabase, response } = await authorize(orgId);
  if (!supabase) return response;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Your account has no email address to send the test to." }, { status: 422 });
  }

  const [{ data: organization }, { data: existing, error: readError }] = await Promise.all([
    supabase.from("organizations").select("name").eq("id", orgId).maybeSingle<{ name: string }>(),
    supabase
      .from("organization_email_senders")
      .select(SENDER_PUBLIC_COLUMNS)
      .eq("org_id", orgId)
      .maybeSingle<OrganizationEmailSenderPublic>(),
  ]);
  if (readError || !organization) {
    return NextResponse.json({ error: "Could not read the email settings." }, { status: 500 });
  }
  if ((existing?.version ?? null) !== input.version) {
    return NextResponse.json(
      { error: "These email settings were changed elsewhere. Reload the page and try again.", code: "version_conflict" },
      { status: 409 }
    );
  }

  const sameServer =
    existing !== null && existing.host === host && existing.port === input.port && existing.username === input.username;
  const service = createServiceClient();
  let password = input.password;
  if (!password) {
    if (!sameServer) {
      return NextResponse.json(
        {
          error: existing
            ? "Enter the password again: the mail server or username changed."
            : "Enter the mail server's password.",
          field: "password",
        },
        { status: 422 }
      );
    }
    // Decrypts only while the saved row is still the one read above, so a
    // password saved for another server meanwhile never reaches this one.
    const { data: saved, error: decryptError } = await service.rpc("fn_organization_email_sender_password", {
      _org_id: orgId,
      _version: existing.version,
      _host: existing.host,
      _port: existing.port,
      _username: existing.username,
    });
    if (decryptError) {
      return NextResponse.json(
        { error: "Could not read the saved password. Enter it again.", field: "password" },
        { status: 500 }
      );
    }
    if (typeof saved !== "string" || !saved) {
      return NextResponse.json(
        { error: "These email settings were changed elsewhere. Reload the page and try again.", code: "version_conflict" },
        { status: 409 }
      );
    }
    password = saved;
  }

  const settings = {
    kind: "smtp" as const,
    host,
    port: input.port,
    username: input.username,
    password,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    replyTo: input.replyTo,
  };
  const runtime = await getMgmRuntime();
  const sent = await runtime.mailTransports
    .create(settings)
    .send(testMessage({ to: user.email, organizationName: organization.name }));

  const testedAt = new Date().toISOString();
  if (!sent.ok) {
    const unchanged =
      sameServer &&
      !input.password &&
      existing.from_address === input.fromAddress &&
      existing.from_name === input.fromName &&
      existing.reply_to === input.replyTo;
    if (unchanged) {
      await service
        .from("organization_email_senders")
        .update({ last_tested_at: testedAt, last_test_status: sent.reason, last_test_message: sent.message })
        .eq("org_id", orgId)
        .eq("version", existing.version);
    }
    return NextResponse.json({ error: sent.message, reason: sent.reason }, { status: 422 });
  }

  const row: Record<string, unknown> = {
    host,
    port: input.port,
    username: input.username,
    from_address: input.fromAddress,
    from_name: input.fromName,
    reply_to: input.replyTo,
    last_tested_at: testedAt,
    last_test_status: "success",
    last_test_message: `Test email sent to ${user.email}.`,
  };
  if (input.password) {
    // Encrypted as the caller, as the payment and OpenEMS settings routes do.
    const { data: encrypted, error: encryptError } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: input.password,
    });
    if (encryptError || !encrypted) {
      return NextResponse.json({ error: "Could not store the password." }, { status: 500 });
    }
    row.password_encrypted = encrypted;
  }

  const saved = existing
    ? await service
        .from("organization_email_senders")
        .update({ ...row, version: existing.version + 1 })
        .eq("org_id", orgId)
        .eq("version", existing.version)
        .select(SENDER_PUBLIC_COLUMNS)
        .maybeSingle<OrganizationEmailSenderPublic>()
    : await service
        .from("organization_email_senders")
        .insert({ ...row, org_id: orgId })
        .select(SENDER_PUBLIC_COLUMNS)
        .maybeSingle<OrganizationEmailSenderPublic>();
  if (saved.error?.code === "23505" || (!saved.error && !saved.data)) {
    return NextResponse.json(
      { error: "These email settings were changed elsewhere. Reload the page and try again.", code: "version_conflict" },
      { status: 409 }
    );
  }
  if (saved.error) {
    return NextResponse.json({ error: "The test email was sent, but the settings could not be saved." }, { status: 500 });
  }
  return NextResponse.json({
    sender: saved.data,
    message: `Test email sent to ${user.email}. Settings saved.`,
  });
}

export async function DELETE(_request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const { id: orgId } = await params;
  const { supabase, response } = await authorize(orgId);
  if (!supabase) return response;
  const { error } = await supabase.from("organization_email_senders").delete().eq("org_id", orgId);
  if (error) {
    return NextResponse.json({ error: "Could not remove the email settings." }, { status: 500 });
  }
  return NextResponse.json({ sender: null });
}
