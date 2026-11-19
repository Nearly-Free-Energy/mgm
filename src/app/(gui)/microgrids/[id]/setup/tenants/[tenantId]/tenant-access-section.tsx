"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogFooter, DialogOverlay, DialogPanel } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { LocalDate } from "@/components/format/local-date";
import { cn } from "@/lib/utils";

/** One person who can sign in to this unit's tenant pages (fn_tenant_access_list). */
export type TenantAccessEntry = {
  accessId: string;
  email: string;
  createdAt: string;
};

export interface TenantAccessSectionProps {
  tenantId: string;
  /** null: the list could not be read. Never shown as "nobody has access". */
  entries: TenantAccessEntry[] | null;
  /** The tenant record's email, offered in the dialog. Nothing is granted from it. */
  suggestedEmail: string | null;
  canManage: boolean;
  /** The tenant app's state for the unit's organization; null when it could not be read. */
  tenantAppOn: boolean | null;
  /** The microgrid's zone, so "Added" reads the same on the server and in the browser. */
  timeZone: string;
  /** MGM's sign-in page, for the manager to pass on when the notice was not sent. */
  loginUrl: string | null;
}

type Outcome = { email: string; emailSent: boolean };

const PRIMARY_BUTTON =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-primary bg-primary px-4 text-dense font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

const REMOVE_BUTTON =
  "inline-flex h-9 shrink-0 items-center justify-center self-start rounded-md border border-destructive px-4 text-dense font-medium text-destructive-fg hover:bg-destructive-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:self-auto";

const REMOVE_FALLBACK = "Could not remove access. Retry the request.";
const UNREACHABLE = "Could not reach MGM. Check your connection and retry.";

/** Programmatic focus targets: not in the Tab order, ringed when reached by keyboard. */
const FOCUS_TARGET = "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * App access on the tenant record (RFC mgm#197 § 6): who can sign in to
 * this unit's tenant pages, Give access and Remove. Give access posts the
 * address to POST /api/tenants/[id]/access, which finds or creates the
 * account and sends the notice; Remove calls
 * DELETE /api/tenants/[id]/access/[accessId]. The empty state owns the
 * Give access button while nobody has access, the list's header once
 * someone has (design rule 6).
 */
export function TenantAccessSection({
  tenantId,
  entries,
  suggestedEmail,
  canManage,
  tenantAppOn,
  timeZone,
  loginUrl,
}: TenantAccessSectionProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [removing, setRemoving] = React.useState<TenantAccessEntry | null>(null);
  // Read out after a removal, whose row and button are gone once the list refreshes.
  const [announcement, setAnnouncement] = React.useState("");
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const outcomeRef = React.useRef<HTMLDivElement>(null);

  // Neither dialog has a Dialog.Trigger, so Radix has no opener to return
  // focus to, and the opener may be gone after the refresh anyway: focus
  // goes to the outcome after a grant and to the section's heading otherwise.
  const focusAfterGive = (event: Event) => {
    event.preventDefault();
    (outcomeRef.current ?? headingRef.current)?.focus();
  };
  const focusAfterRemove = (event: Event) => {
    event.preventDefault();
    headingRef.current?.focus();
  };

  // The outcome banner names one address; once that address is removed it
  // would say the opposite of the list.
  function clearOutcomeFor(entry: TenantAccessEntry) {
    setOutcome((current) =>
      current && current.email.toLowerCase() === entry.email.toLowerCase() ? null : current
    );
  }

  const canGive = canManage && tenantAppOn !== false && entries !== null;
  const giveButton = canGive ? (
    <button
      type="button"
      className={PRIMARY_BUTTON}
      onClick={() => {
        setOutcome(null);
        setAnnouncement("");
        setDialogOpen(true);
      }}
    >
      Give access
    </button>
  ) : undefined;

  function removed(entry: TenantAccessEntry) {
    clearOutcomeFor(entry);
    setAnnouncement(`Access removed for ${entry.email}.`);
    router.refresh();
  }

  async function remove(entry: TenantAccessEntry) {
    let res: Response;
    try {
      res = await fetch(`/api/tenants/${tenantId}/access/${entry.accessId}`, {
        method: "DELETE",
      });
    } catch {
      // The request never reached MGM; ConfirmDialog shows this with Retry.
      throw new Error(UNREACHABLE);
    }
    if (res.status === 204) {
      removed(entry);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    // Already gone, here or elsewhere: show the list as it is now.
    if (res.status === 404 && body.code === "access_not_found") {
      removed(entry);
      return;
    }
    throw new Error(body.error ?? REMOVE_FALLBACK);
  }

  return (
    <section aria-labelledby="app-access-heading">
      <h4
        id="app-access-heading"
        ref={headingRef}
        tabIndex={-1}
        className={cn(
          "mb-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground",
          FOCUS_TARGET
        )}
      >
        App access
      </h4>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="space-y-3">
        {outcome && (
          <div ref={outcomeRef} tabIndex={-1} data-testid="access-outcome" className={FOCUS_TARGET}>
            <OutcomeBanner outcome={outcome} loginUrl={loginUrl} />
          </div>
        )}

        {entries !== null && tenantAppOn === false && (
          <Banner tone="warn" title="The tenant app is not on yet">
            The tenant app is not on for this organization yet. You can give
            access once it is on. Access already given stays and can still be
            removed.
          </Banner>
        )}

        {entries === null ? (
          <Banner tone="destructive" title="Could not load app access">
            Reload the page to see who can sign in to this unit.
          </Banner>
        ) : entries.length === 0 ? (
          <EmptyState
            eyebrow="App access"
            title="Give this tenant access to the app"
            body="People with access sign in with their email address and see this unit's electricity use by month and by day. Nobody can sign in to this unit yet."
            cta={giveButton}
            footnote={!canManage ? "Only an organization manager can give access." : undefined}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-dense text-muted-foreground">
                These addresses can sign in and see this unit&apos;s electricity use.
              </p>
              {giveButton}
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {entries.map((entry) => (
                <li
                  key={entry.accessId}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="break-all text-body text-foreground">{entry.email}</p>
                    <p className="text-caption text-subtle-foreground">
                      Added{" "}
                      <LocalDate
                        value={entry.createdAt}
                        opts={{ year: "numeric", month: "short", day: "numeric", timeZone }}
                      />
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className={REMOVE_BUTTON}
                      aria-label={`Remove access for ${entry.email}`}
                      onClick={() => setRemoving(entry)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {canGive && (
        <GiveAccessDialog
          tenantId={tenantId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          suggestedEmail={suggestedEmail}
          onCloseAutoFocus={focusAfterGive}
          onGiven={(given) => {
            setOutcome(given);
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        tone="destructive"
        eyebrow="Remove access"
        // The address goes in the body, where it can wrap; a title has no
        // break opportunity in an email address and would scroll at 360 px.
        title="Remove this person's access?"
        body={
          removing ? (
            // "Even if they are signed in right now" holds while every tenant
            // read re-reads the person's role rows on each request (the RLS
            // helpers and authorizeTenant in composeTenantApp) and no usage
            // figure is served before that check; if either changes, revisit.
            <p>
              <span className="break-all">{removing.email}</span> will no longer see this
              unit&apos;s electricity use, from now on, even if they are signed in right now.
              Their MGM sign-in account is kept, and you can give access again at any time.
            </p>
          ) : undefined
        }
        confirmLabel="Remove access"
        onCloseAutoFocus={focusAfterRemove}
        onConfirm={async () => {
          if (removing) await remove(removing);
        }}
      />
    </section>
  );
}

function OutcomeBanner({ outcome, loginUrl }: { outcome: Outcome; loginUrl: string | null }) {
  if (outcome.emailSent) {
    return (
      <Banner tone="success" title="Access given">
        <span className="break-all">{outcome.email}</span> can now sign in. MGM sent them a
        notice.
      </Banner>
    );
  }
  return (
    <Banner tone="warn" title="Access given, but the notice was not sent">
      {loginUrl ? (
        <>
          Tell <span className="break-all">{outcome.email}</span> to go to <span className="break-all">{loginUrl}</span> and
          choose &ldquo;Email me a sign-in link&rdquo; with this address.
        </>
      ) : (
        <>
          Tell <span className="break-all">{outcome.email}</span> to open MGM&apos;s sign-in page and choose &ldquo;Email me a
          sign-in link&rdquo; with this address.
        </>
      )}
    </Banner>
  );
}

const EMAIL_FIELD = "tenant-access-email";

function GiveAccessDialog({
  tenantId,
  open,
  onOpenChange,
  suggestedEmail,
  onGiven,
  onCloseAutoFocus,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedEmail: string | null;
  onGiven: (outcome: Outcome) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [email, setEmail] = React.useState(suggestedEmail ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // A fresh form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setEmail(suggestedEmail ?? "");
      setError(null);
      setFieldError(false);
      setSubmitting(false);
    }
  }, [open, suggestedEmail]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) {
      setError("Enter an email address.");
      setFieldError(true);
      return;
    }
    setError(null);
    setFieldError(false);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tenants/${tenantId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        field?: string;
        email?: string;
        email_sent?: boolean;
      };
      if (res.status !== 201) {
        setError(body.error ?? "Could not give access. Retry the request.");
        setFieldError(body.field === "email");
        setSubmitting(false);
        return;
      }
      onGiven({ email: body.email ?? address, emailSent: body.email_sent === true });
      onOpenChange(false);
    } catch {
      setError(UNREACHABLE);
      setSubmitting(false);
    }
  }

  const describedBy = error ? `${EMAIL_FIELD}-help ${EMAIL_FIELD}-err` : `${EMAIL_FIELD}-help`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay />
        <DialogPanel className="w-[480px]" onCloseAutoFocus={onCloseAutoFocus}>
          <div className="px-6 pt-5">
            <Dialog.Title className="text-title font-semibold tracking-tight text-foreground">
              Give access to the app
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-dense text-muted-foreground">
              The person signs in with this address and sees this unit&apos;s
              electricity use by month and by day.
            </Dialog.Description>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 px-6 pb-2 pt-4" noValidate>
            {error && (
              <Banner id={`${EMAIL_FIELD}-err`} tone="destructive" title="Could not give access">
                {/* The server's copy may carry the address, which has no break opportunity. */}
                <span className="break-words">{error}</span>
              </Banner>
            )}

            <div>
              <label
                htmlFor={EMAIL_FIELD}
                className="mb-1 block text-caption font-medium text-muted-foreground"
              >
                Email address
              </label>
              <Input
                id={EMAIL_FIELD}
                type="email"
                autoComplete="off"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                aria-describedby={describedBy}
                aria-invalid={fieldError ? true : undefined}
                className={cn(fieldError && "border-destructive")}
              />
              <p id={`${EMAIL_FIELD}-help`} className="mt-1 text-caption text-subtle-foreground">
                MGM emails this address a notice that they can sign in. They sign
                in with a link MGM sends them; there is no password.
              </p>
            </div>

            <DialogFooter className="-mx-6 -mb-2 mt-4">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-md px-4 text-dense font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
                {submitting ? "Giving access…" : "Give access"}
              </button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
