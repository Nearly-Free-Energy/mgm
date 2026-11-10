"use client";

/**
 * One Value, printed as the server formatted it: `text` already carries the
 * unit and the locale's digits, so nothing here formats a number. A status
 * is a chip; a calculated value is marked "≈", a generated one "Synthetic";
 * a measured one shows its age, and "stale" once the view's live settings
 * say so.
 */
import { Chip } from "@/components/ui/chip";
import { CHIP_TONE } from "@/components/ui/status-chip";
import type { LiveState, Value as ValueOf } from "../contract";
import { isHref } from "../host/shared/href";
import { Link } from "../host/client/navigation";

/** "40 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function ageText(seconds: number): string {
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** True when Value draws this value as its own link, so a row link must not wrap it. */
export function linksItself(value: ValueOf | undefined): boolean {
  return value?.t === "ref" && !!value.ref.href && isHref(value.ref.href);
}

export function Value({ value, live }: { value: ValueOf; live?: Pick<LiveState, "ageSeconds" | "stale"> }) {
  const age = live?.ageSeconds(value) ?? null;
  const stale = age !== null && !!live?.stale(value);
  let shown;
  if (value.t === "status") {
    shown = <Chip tone={CHIP_TONE[value.tone] ?? "neutral"}>{value.text}</Chip>;
  } else if (value.t === "ref" && linksItself(value)) {
    shown = <Link href={value.ref.href!}>{value.text}</Link>;
  } else {
    // Every other type, and one this kit does not know yet, prints its text.
    shown = <span className={value.t === "empty" ? "text-muted-foreground" : undefined}>{value.text}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1" data-gui-value={value.t}>
      {value.derived && (
        <span title="Calculated">
          <span aria-hidden="true">≈</span>
          <span className="sr-only">Calculated:</span>
        </span>
      )}
      {shown}
      {value.synthetic && <span className="text-caption font-semibold uppercase text-muted-foreground">Synthetic</span>}
      {age !== null && (
        <span className={stale ? "text-caption text-warning-fg" : "text-caption text-muted-foreground"}>
          {ageText(age)}
          {stale && ", stale"}
        </span>
      )}
    </span>
  );
}
