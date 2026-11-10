"use client";

/** The parts KitView and RawView share: the header with its actions and links, and the notice. */
import { useId, useState } from "react";
import { Banner, type BannerTone } from "@/components/ui/banner";
import { cn } from "@/lib/utils";
import type { ActionRef, LinkRef, Tone, ViewModel } from "../contract";
import { isHref, isOutHref } from "../host/shared/href";
import { act, open } from "../host/client/kit-runtime";

const BANNER_TONE: Record<Tone, BannerTone> = {
  neutral: "info",
  info: "info",
  accent: "info",
  success: "success",
  warning: "warn",
  danger: "destructive",
};

export const BUTTON =
  "inline-flex h-8 items-center gap-2 rounded-md border px-3.5 text-dense font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

/** A control that writes only through kit.act; the action host runs the form, the confirmation and the request. */
export function ActionButton({ actionRef }: { actionRef: ActionRef }) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposed = !!actionRef.provenance;
  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await act(actionRef);
    setBusy(false);
    if (!result.ok && result.code !== "cancelled") setError(result.message);
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={!actionRef.enabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={!actionRef.enabled && actionRef.reason ? reasonId : undefined}
        data-gui-action={actionRef.action}
        className={cn(
          BUTTON,
          actionRef.tone === "danger"
            ? "border-destructive bg-destructive-muted text-destructive-fg"
            : "border-border bg-card text-foreground hover:bg-muted",
          proposed && "border-dashed",
        )}
      >
        {proposed && <span className="text-caption font-semibold uppercase text-muted-foreground">Proposed</span>}
        {actionRef.label}
      </button>
      {!actionRef.enabled && actionRef.reason && (
        <span id={reasonId} className="text-caption text-muted-foreground">
          {actionRef.reason}
        </span>
      )}
      {error && (
        <span role="status" className="text-caption text-destructive-fg">
          {error}
        </span>
      )}
    </span>
  );
}

/** A GET the person opens: a real anchor, so its href is in the DOM, opened through kit.open. */
export function LinkItem({ link }: { link: LinkRef }) {
  if (!isHref(link.href) && !isOutHref(link.href)) return <span>{link.label}</span>;
  return (
    <a
      href={link.href}
      className="text-dense font-medium text-primary underline-offset-2 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        void open(link);
      }}
    >
      {link.label}
    </a>
  );
}

export function Notice({ notice }: { notice: NonNullable<ViewModel["notice"]> }) {
  return (
    <Banner tone={BANNER_TONE[notice.tone] ?? "info"} title={notice.text}>
      {null}
    </Banner>
  );
}

/** Title, subtitle, actions, links and notice. `hide` leaves out actions another part already shows. */
export function ViewHeader({ model, depth, hide }: { model: ViewModel; depth: number; hide?: string }) {
  const Heading = depth === 0 ? "h1" : "h2";
  const actions = model.actions.filter((ref) => ref.action !== hide);
  return (
    <header className="flex flex-col gap-2">
      <Heading className="text-title font-semibold text-foreground">{model.title}</Heading>
      {model.subtitle && <p className="text-body text-muted-foreground">{model.subtitle}</p>}
      {(actions.length > 0 || model.links.length > 0) && (
        <div className="flex flex-wrap items-start gap-2">
          {actions.map((ref, i) => (
            <ActionButton key={`${ref.action}-${i}`} actionRef={ref} />
          ))}
          {model.links.map((link) => (
            <LinkItem key={link.id} link={link} />
          ))}
        </div>
      )}
      {model.notice && <Notice notice={model.notice} />}
    </header>
  );
}
