"use client";
import { useCallback, useEffect, useState } from "react";
import type { OrganizationEmailSenderPublic } from "@/lib/email/organization-sender";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Fields = {
  host: string;
  port: "465" | "587";
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
};

const EMPTY: Fields = { host: "", port: "587", username: "", password: "", fromAddress: "", fromName: "", replyTo: "" };

function fieldsOf(sender: OrganizationEmailSenderPublic | null): Fields {
  if (!sender) return EMPTY;
  return {
    host: sender.host,
    port: sender.port === 465 ? "465" : "587",
    username: sender.username,
    password: "",
    fromAddress: sender.from_address,
    fromName: sender.from_name ?? "",
    replyTo: sender.reply_to ?? "",
  };
}

const INPUT = "block w-full rounded-md border border-border bg-card px-3 py-2 text-foreground";

export function SenderSettings({ orgId }: { orgId: string }) {
  const [sender, setSender] = useState<OrganizationEmailSenderPublic | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const url = `/api/organizations/${orgId}/email-sender`;

  /** Reads the saved sender; `keepFields` leaves what the person typed in place. */
  const load = useCallback(
    async (keepFields = false) => {
      const response = await fetch(url);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setSender(value.sender);
      if (!keepFields) setFields(fieldsOf(value.sender));
      setReady(true);
    },
    [url]
  );
  useEffect(() => {
    load().catch((error) => setErrorMessage(error.message));
  }, [load]);

  const set = (name: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((current) => ({ ...current, [name]: event.target.value }));

  async function save() {
    setBusy(true);
    setMessage("");
    setErrorMessage("");
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, port: Number(fields.port), version: sender?.version ?? null }),
      });
      const value = await response.json();
      if (!response.ok) {
        // A failed test of the saved settings is recorded on them; show it,
        // and keep the edited fields so the person can correct them.
        if (sender) await load(true).catch(() => undefined);
        throw new Error(value.error);
      }
      setSender(value.sender);
      setFields(fieldsOf(value.sender));
      setMessage(value.message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The test email could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage("");
    setErrorMessage("");
    try {
      // The route requires the server's name, typed; the dialog enables
      // Remove only once the input, trimmed, is that name.
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: { acknowledged: [], typed: sender?.host ?? "" } }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setSender(null);
      setFields(EMPTY);
      setMessage("Email settings removed. Notices now go through MGM's own mail server.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not remove the email settings.");
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  const failing = sender?.last_test_status && sender.last_test_status !== "success";
  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold text-foreground">Email</h1>
      <p className="text-muted-foreground">
        The mail server this organization sends its notices through, such as invitations. Sign-in links and codes
        never go through it: MGM sends those from its own mail server. Until a server is saved here, notices go
        through MGM&rsquo;s own mail server too.
      </p>
      {errorMessage && (
        <div role="alert" className="rounded-md border border-destructive bg-destructive-muted p-4 text-destructive-fg">
          <h2 className="font-semibold">The test email was not sent</h2>
          <p className="mt-1">{errorMessage}</p>
        </div>
      )}
      {message && (
        <p role="status" className="rounded-md border border-success bg-success-muted p-4 text-success-fg">
          {message}
        </p>
      )}
      {!ready && !errorMessage && <p>Loading email settings…</p>}
      {ready && sender && (
        <p className={failing ? "rounded-md bg-warning-muted p-3 text-warning-fg" : "text-muted-foreground"}>
          {failing ? "The last test of the saved settings failed: " : "Saved. "}
          {sender.last_test_message}
        </p>
      )}
      {ready && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block">
            Mail server
            <input required value={fields.host} onChange={set("host")} placeholder="smtp.example.com" className={INPUT} />
          </label>
          <label className="block">
            Port
            <select value={fields.port} onChange={set("port")} className={INPUT}>
              <option value="587">587 (STARTTLS)</option>
              <option value="465">465 (TLS)</option>
            </select>
          </label>
          <label className="block">
            Username
            <input required autoComplete="off" value={fields.username} onChange={set("username")} className={INPUT} />
          </label>
          <label className="block">
            Password
            <input
              type="password"
              autoComplete="new-password"
              value={fields.password}
              onChange={set("password")}
              required={!sender}
              className={INPUT}
            />
          </label>
          {sender && (
            <p className="text-sm text-muted-foreground">
              Leave the password blank to keep the saved one. Changing the server, port or username needs it again.
            </p>
          )}
          <label className="block">
            From address
            <input
              required
              type="email"
              value={fields.fromAddress}
              onChange={set("fromAddress")}
              placeholder="notices@example.com"
              className={INPUT}
            />
          </label>
          <label className="block">
            From name (optional)
            <input value={fields.fromName} onChange={set("fromName")} className={INPUT} />
          </label>
          <label className="block">
            Reply-to address (optional)
            <input type="email" value={fields.replyTo} onChange={set("replyTo")} className={INPUT} />
          </label>
          <p className="text-sm text-muted-foreground">
            Saving sends a test email to you through these settings. They are saved only if it is accepted.
          </p>
          <div className="flex gap-3">
            <button disabled={busy} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
              {busy ? "Sending test…" : "Send test email and save"}
            </button>
            {sender && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                className="rounded-md border border-border px-4 py-2 text-foreground disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        tone="destructive"
        title="Remove these email settings?"
        description="Notices will go through MGM's own mail server. The saved password is deleted. Type the mail server's name to confirm."
        confirmLabel="Remove"
        requireTypedConfirmation={{ label: "Type the mail server's name to confirm", expected: sender?.host ?? "" }}
        onConfirm={remove}
      />
    </section>
  );
}
