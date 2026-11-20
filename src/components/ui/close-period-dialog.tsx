"use client";

// ClosePeriodDialog — the legacy billing page's Close period flow, framing
// the host's confirmation step (#201).
//
// The dialog shows exactly what the server will check. On open it posts the
// close with no confirmation; the route answers 428 with the close review and
// its `ceremony` (src/lib/billing/close-ceremony.ts): the totals, the
// warnings, the acknowledgements to tick and the period name to type. The
// host's ConfirmStep (src/lib/gui/host/client/confirm-step.tsx) renders it,
// the same step a contributed close action gets, so every interface closes
// the same way. Confirm posts `{ confirmation: { digest, acknowledged, typed } }`,
// and fn_close_billing_period checks the digest and the acknowledgements in
// the same transaction as the close.
//
// Phases:
//   loading — the review is being fetched.
//   review  — ConfirmStep. A 409 billing_period_totals_changed starts the
//             step again over the new totals (ticks and typing cleared), with
//             CLOSE_REFUSAL_COPY.totalsChanged as its note: the ceremony the
//             409 carries, or the review loaded again when it carries none.
//   blocked — the period cannot close as it is (a bill total that is not a
//             whole number, or already closed); nothing to confirm.
//   failed  — the review could not be loaded; Retry fetches it again.
//   closed  — green header and "Export CSV for URA".
//
// Decision 1 on #201 replaced the earlier checkbox-only confirm: the person
// sees the totals, ticks each acknowledgement and types the period's name.
//
// Tone: closing is a final commit, not a destruction, so the rail and the
// step are neutral (primary). Destructive tokens are kept for delete flows.
//
// A11y: Radix gives role="dialog", aria-modal, the focus trap and Esc. Focus
// starts on Cancel (ConfirmStep focuses its own Cancel; the other phases
// focus theirs), so the safe option comes first.

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { DialogFooter, DialogOverlay, DialogPanel } from "@/components/ui/dialog";
import { ConfirmStep } from "@/lib/gui/host/client/confirm-step";
import type { Ceremony } from "@/lib/gui/contract";
import { CLOSE_REFUSAL_COPY } from "@/lib/billing/close";

export interface ClosePeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: string;
  /** Called once the period is closed, for example to refresh the page. */
  onClosed: () => void;
  /** Called when the user clicks "Export CSV for URA" in the closed state. */
  onExportCsv?: () => void;
  /**
   * Sends a body to the close route and reads its answer. Defaults to the
   * real request; the component gallery and tests pass their own.
   */
  post?: (periodId: string, body: unknown) => Promise<CloseAnswer>;
}

export type CloseAnswer = {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  ceremony?: Ceremony;
};

type State =
  | { phase: "loading" }
  | { phase: "review"; ceremony: Ceremony; round: number; busy: boolean; error: string | null }
  | { phase: "blocked"; ceremony: Ceremony | null; message: string }
  | { phase: "failed"; message: string }
  | { phase: "closed"; name: string };

export async function postClose(periodId: string, body: unknown): Promise<CloseAnswer> {
  let res: Response;
  try {
    res = await fetch(`/api/billing-periods/${periodId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, message: "Network error." };
  }
  const json = (await res.json().catch(() => ({}))) as {
    code?: unknown;
    message?: unknown;
    error?: unknown;
    ceremony?: unknown;
  };
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const ceremony =
    json.ceremony && typeof json.ceremony === "object" && (json.ceremony as Ceremony).type === "ceremony"
      ? (json.ceremony as Ceremony)
      : undefined;
  return {
    ok: res.ok,
    status: res.status,
    code: text(json.code),
    message: text(json.message) ?? text(json.error),
    ceremony,
  };
}

/** Why the period cannot close as it is, or null when the answer is something else. */
function blockedBy(answer: CloseAnswer): string | null {
  if (answer.code === "billing_close_fractional_totals") {
    return answer.message ?? "Regenerate the bills whose totals are not whole numbers before closing.";
  }
  if (answer.code === "billing_period_closed") return "This period is already closed.";
  return null;
}

const BUTTON =
  "inline-flex min-h-8 items-center rounded-md px-3.5 text-dense font-medium pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ClosePeriodDialog({
  open,
  onOpenChange,
  periodId,
  onClosed,
  onExportCsv,
  post = postClose,
}: ClosePeriodDialogProps) {
  const [state, setState] = React.useState<State>({ phase: "loading" });
  // The record of the step: what was ticked and typed, from real input only
  // (ConfirmStep hands over a tick or a keystroke only when it is trusted).
  // This, not anything else on the page, is what is sent.
  const record = React.useRef<{ ticked: Set<string>; typed: string }>({ ticked: new Set(), typed: "" });
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const live = React.useRef(0);
  // Each review shown gets a new round, which remounts the step, so nothing
  // ticked or typed over earlier totals stays on screen.
  const rounds = React.useRef(0);

  /** Loads the review; `note` is shown over it, as after totals that changed. */
  const load = React.useCallback(async (note?: string) => {
    const call = ++live.current;
    setState({ phase: "loading" });
    const answer = await post(periodId, {});
    if (call !== live.current) return;
    record.current = { ticked: new Set(), typed: "" };
    if (answer.status === 428 && answer.ceremony) {
      setState({ phase: "review", ceremony: answer.ceremony, round: ++rounds.current, busy: false, error: note ?? null });
      return;
    }
    const blocked = blockedBy(answer);
    if (blocked) {
      setState({ phase: "blocked", ceremony: answer.ceremony ?? null, message: blocked });
      return;
    }
    setState({ phase: "failed", message: answer.message ?? "Could not load the period's totals." });
  }, [periodId, post]);

  // Every opening starts from the server's current review.
  React.useEffect(() => {
    if (open) void load();
    else live.current++;
  }, [open, load]);

  async function confirm() {
    if (state.phase !== "review" || state.busy) return;
    const { ceremony } = state;
    setState({ ...state, busy: true, error: null });
    const call = ++live.current;
    const answer = await post(periodId, {
      confirmation: {
        digest: ceremony.digest,
        acknowledged: [...record.current.ticked],
        typed: record.current.typed.trim(),
      },
    });
    // A close that went through is reported whatever happened to the
    // dialog meanwhile, so the page refreshes; only the dialog's own state
    // is left alone when it has been closed or reopened since.
    if (answer.ok) {
      onClosed();
      if (call === live.current) setState({ phase: "closed", name: ceremony.typed ?? "" });
      return;
    }
    if (call !== live.current) return;
    if (answer.code === "billing_period_totals_changed") {
      if (!answer.ceremony) return void load(CLOSE_REFUSAL_COPY.totalsChanged);
      record.current = { ticked: new Set(), typed: "" };
      setState({ phase: "review", ceremony: answer.ceremony, round: ++rounds.current, busy: false, error: CLOSE_REFUSAL_COPY.totalsChanged });
      return;
    }
    const blocked = blockedBy(answer);
    if (blocked) {
      setState({ phase: "blocked", ceremony: answer.ceremony ?? ceremony, message: blocked });
      return;
    }
    setState({ ...state, busy: false, error: answer.message ?? "Could not close the period." });
  }

  // While a close is being sent the dialog stays open, so its answer is shown:
  // Cancel, Esc and a press outside do nothing until it arrives.
  const sending = state.phase === "review" && state.busy;
  const dismiss = (next: boolean) => {
    if (!next && sending) return;
    onOpenChange(next);
  };

  const name =
    state.phase === "review" ? state.ceremony.typed : state.phase === "blocked" ? state.ceremony?.typed : undefined;
  const closed = state.phase === "closed";
  const title = closed ? `Closed: ${state.name}` : name ? `Close ${name}?` : "Close billing period?";
  // The step's own statement says bills become final, so the review phase
  // keeps only the URA note here rather than saying it twice.
  const description = closed
    ? "This period is now read-only. Export the CSV for your URA filing."
    : state.phase === "review"
      ? "This period will be filed with URA, so the values you copy after this are the values you report."
      : "Bills become final. This period will be filed with URA, so the values you copy after this are the values you report.";

  return (
    <Dialog.Root open={open} onOpenChange={dismiss}>
      <Dialog.Portal>
        <DialogOverlay />
        <DialogPanel
          // ConfirmStep focuses its own Cancel; the other phases focus theirs.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (sending) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (sending) e.preventDefault();
          }}
          aria-describedby="close-period-desc"
          className="w-[480px]"
        >
          {/* primary top-rail: a commit moment, not a destruction */}
          <div aria-hidden="true" className="h-[6px] bg-primary" />

          <div className={cn("px-6 pb-2 pt-5", closed && "bg-success-muted")}>
            <span
              className={cn(
                "text-caption font-semibold uppercase tracking-wide",
                closed ? "text-success-fg" : "text-primary"
              )}
            >
              {closed ? "Closed" : "Final review"}
            </span>
            <Dialog.Title className="mt-1.5 text-xl font-semibold tracking-tight">{title}</Dialog.Title>
            <Dialog.Description id="close-period-desc" className="mt-1 text-dense leading-relaxed text-muted-foreground">
              {description}
            </Dialog.Description>
          </div>

          {state.phase === "review" && (
            <ConfirmStep
              key={state.round}
              level="ceremony"
              title="Close period"
              tone="neutral"
              ceremony={state.ceremony}
              busy={state.busy}
              error={state.error}
              onConfirm={() => void confirm()}
              onTick={(id, _event, box) => {
                if (box.checked) record.current.ticked.add(id);
                else record.current.ticked.delete(id);
              }}
              onType={(_event, input) => {
                record.current.typed = input.value;
              }}
              onCancel={() => dismiss(false)}
            />
          )}

          {state.phase === "loading" && (
            <p className="px-6 pt-3 text-dense text-muted-foreground" role="status">
              Loading the period&apos;s totals…
            </p>
          )}

          {state.phase === "blocked" && (
            <div className="flex flex-col gap-3 px-6 pt-3 text-dense">
              <p role="alert" className="rounded-md bg-warning-muted px-3 py-2.5 text-warning-fg">
                {state.message}
              </p>
              {state.ceremony && state.ceremony.facts.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {state.ceremony.facts.map((fact, i) => (
                    <div key={i} className="contents">
                      <dt className="text-muted-foreground">{fact.label}</dt>
                      <dd>{fact.value.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {state.phase === "failed" && (
            <div className="px-6 pt-3">
              <p role="alert" className="rounded-md bg-destructive-muted px-3 py-2.5 text-dense text-destructive-fg">
                <b>Couldn&apos;t load the period&apos;s totals.</b> {state.message} Your draft is unchanged.
              </p>
            </div>
          )}

          {state.phase !== "review" && (
            <DialogFooter className="mt-3">
              {closed && (
                <div className="mr-auto text-caption max-[600px]:basis-full">
                  <span className="inline-flex items-center gap-1 font-semibold text-success-fg">✓ Closed · read-only</span>
                </div>
              )}
              <Dialog.Close asChild>
                <button ref={cancelRef} type="button" className={cn(BUTTON, "text-foreground hover:bg-muted")}>
                  {closed ? "Done" : "Cancel"}
                </button>
              </Dialog.Close>
              {state.phase === "failed" && (
                <button
                  type="button"
                  onClick={() => void load()}
                  className={cn(BUTTON, "border border-primary bg-primary text-primary-foreground")}
                >
                  Retry
                </button>
              )}
              {closed && onExportCsv && (
                <button
                  type="button"
                  onClick={onExportCsv}
                  className={cn(BUTTON, "border border-primary bg-primary text-primary-foreground")}
                >
                  Export CSV for URA
                </button>
              )}
            </DialogFooter>
          )}
        </DialogPanel>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
