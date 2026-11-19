"use client";

/**
 * The period review's controls and values: an action, which writes only
 * through kit.act with the ref the model gave; a link, a page through
 * kit.Link and a download through kit.open; a bill's own actions and links
 * behind a disclosure; and one Value as the server formatted it.
 */
import { useId, useState } from "react";
import type { ActionRef, GuiKit, Href, LinkRef, LiveState, RowOf, Tone, Value } from "@/lib/gui/contract";
import { cls } from "./ext";

// The window bar's control style (../../shell/window-bar.tsx), at least 44 px high on a touch screen.
export const CONTROL =
  "gt:inline-flex gt:h-8 gt:items-center gt:gap-2 gt:rounded-md gt:border gt:px-3 gt:text-dense gt:font-medium " +
  "gt:pointer-coarse:h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:disabled:cursor-not-allowed gt:disabled:opacity-60";
const QUIET = "gt:border-border gt:bg-card gt:text-foreground gt:hover:bg-muted";
const LINK = "gt:border-transparent gt:text-primary gt:hover:underline";

export const TONE: Record<Tone, string> = {
  neutral: "gt:bg-muted gt:text-muted-foreground",
  info: "gt:bg-muted gt:text-muted-foreground",
  accent: "gt:bg-accent gt:text-accent-foreground",
  success: "gt:bg-success-muted gt:text-success-fg",
  warning: "gt:bg-warning-muted gt:text-warning-fg",
  danger: "gt:bg-destructive-muted gt:text-destructive-fg",
};

/** A status as a chip in its tone. */
export function Chip({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span className={cls("gt:inline-flex gt:items-center gt:rounded-pill gt:px-2 gt:text-caption gt:font-medium gt:whitespace-nowrap", TONE[tone] ?? TONE.neutral)}>
      {text}
    </span>
  );
}

/** "40 s ago", "5 min ago", "3 h ago", "2 d ago", as the kit says it. */
function ageText(seconds: number): string {
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/**
 * One value, printed as the server formatted it: a status as a chip, an
 * entity with a page as a link to it, anything else as its text, which is
 * always the innermost element holding it. A calculated value is marked "≈",
 * a generated one "Synthetic", and a measured one shows its age.
 */
export function ValueText({ value, live, kit }: { value: Value | undefined; live: Pick<LiveState, "ageSeconds" | "stale">; kit: GuiKit }) {
  if (!value) return null;
  const age = live.ageSeconds(value);
  const stale = age !== null && live.stale(value);
  let shown;
  if (value.t === "status") shown = <Chip text={value.text} tone={value.tone} />;
  else if (value.t === "ref" && value.ref.href?.startsWith("/")) {
    shown = (
      <kit.Link href={value.ref.href} className="gt:inline-flex gt:items-center gt:text-primary gt:hover:underline gt:pointer-coarse:min-h-11">
        {value.text}
      </kit.Link>
    );
  } else shown = <span className={value.t === "empty" ? "gt:text-muted-foreground" : undefined}>{value.text}</span>;
  return (
    <span className="gt:inline-flex gt:flex-wrap gt:items-baseline gt:gap-x-1">
      {value.derived && (
        <span title="Calculated">
          <span aria-hidden="true">≈</span>
          <span className="gt:sr-only">Calculated:</span>
        </span>
      )}
      {shown}
      {value.synthetic && <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">Synthetic</span>}
      {age !== null && (
        <span className={cls("gt:text-caption", stale ? "gt:text-warning-fg" : "gt:text-muted-foreground")}>
          {ageText(age)}
          {stale && ", stale"}
        </span>
      )}
    </span>
  );
}

/** Writes only through kit.act, with the ref as the model gave it; a disabled action says why instead. */
export function ActionControl({ actionRef, onResult, kit }: { actionRef: ActionRef; onResult(message: string | null): void; kit: GuiKit }) {
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    onResult(null);
    const result = await kit.act(actionRef);
    setBusy(false);
    if (!result.ok && result.code !== "cancelled") onResult(result.message);
  };
  const disabled = !actionRef.enabled;
  return (
    <span className="gt:inline-flex gt:flex-col gt:gap-1">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={disabled && actionRef.reason ? reasonId : undefined}
        className={cls(
          CONTROL,
          actionRef.tone === "danger" ? "gt:border-destructive gt:bg-destructive-muted gt:text-destructive-fg" : QUIET,
          actionRef.provenance && "gt:border-dashed",
        )}
      >
        {actionRef.provenance && <span className="gt:text-caption gt:font-semibold gt:text-muted-foreground">Proposed:</span>}
        {actionRef.label}
      </button>
      {disabled && actionRef.reason && (
        <span id={reasonId} className="gt:text-caption gt:text-muted-foreground">
          {actionRef.reason}
        </span>
      )}
    </span>
  );
}

/**
 * A page through kit.Link. A download, a share, an API path or an outside
 * target is an anchor that opens it through kit.open, so its href is in the
 * page; a modified or middle click is left to the browser.
 */
export function LinkControl({ link, kit, className = cls(CONTROL, LINK) }: { link: LinkRef; kit: GuiKit; className?: string }) {
  const page = link.href.startsWith("/") && !link.href.startsWith("/api/") && !link.download && !link.share;
  if (page) {
    return (
      <kit.Link href={link.href as Href} className={className}>
        {link.label}
      </kit.Link>
    );
  }
  return (
    <a
      href={link.href}
      className={className}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void kit.open(link);
      }}
    >
      {link.label}
    </a>
  );
}

/** The model's own actions and links, with the failure of the last action pressed. */
export function ControlList({ actions, links, kit, label }: { actions: ActionRef[]; links: LinkRef[]; kit: GuiKit; label: string }) {
  const [error, setError] = useState<string | null>(null);
  if (actions.length + links.length === 0) return null;
  return (
    <div className="gt:flex gt:flex-col gt:gap-2">
      <ul aria-label={label} className="gt:flex gt:flex-wrap gt:items-start gt:gap-2">
        {actions.map((ref, i) => (
          <li key={`${ref.action}-${i}`}>
            <ActionControl actionRef={ref} onResult={setError} kit={kit} />
          </li>
        ))}
        {links.map((link) => (
          <li key={link.id}>
            <LinkControl link={link} kit={kit} />
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A bill's actions and links behind a native disclosure, which needs no
 * script. Its content stays in the page while it is closed, so a disabled
 * action's reason is there from the first render, and it opens in the flow
 * of the row rather than over it.
 */
export function RowControls({ row, tenant, kit }: { row: RowOf<ActionRef>; tenant: string; kit: GuiKit }) {
  const links = row.links ?? [];
  if (row.actions.length + links.length === 0) return null;
  return (
    <details>
      <summary
        aria-label={`Actions for ${tenant}`}
        className="gt:inline-flex gt:cursor-pointer gt:items-center gt:rounded-md gt:px-2 gt:text-dense gt:font-medium gt:text-primary gt:h-8 gt:pointer-coarse:min-h-11 gt:pointer-coarse:min-w-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring"
      >
        Actions
      </summary>
      <div className="gt:mt-2 gt:mb-1">
        <ControlList actions={row.actions} links={links} kit={kit} label={`Actions for ${tenant}`} />
      </div>
    </details>
  );
}
