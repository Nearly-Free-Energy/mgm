"use client";

/**
 * The confirmation step before a write, owned by the host (decision 5 on
 * #115): a GUI frames it in its Overlay but never supplies or alters it.
 * Ticks, typing and Confirm count only from real input (./trusted.ts), so a
 * script cannot confirm on the person's behalf. Confirm is the only thing
 * that calls onConfirm: nothing submits on mount, on Enter or on a tick.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Ceremony, Confirmation } from "../../contract";
import { isTrusted } from "./trusted";

export interface ConfirmStepProps {
  level: "confirm" | "typed" | "ceremony";
  title: string;
  tone: "neutral" | "danger";
  ceremony: Ceremony | null;
  busy: boolean;
  error: string | null;
  onConfirm(confirmation: Confirmation): void;
  onCancel(): void;
}

const BUTTON =
  "inline-flex min-h-8 items-center rounded-md border px-3.5 text-dense font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export function ConfirmStep({ level, title, tone, ceremony, busy, error, onConfirm, onCancel }: ConfirmStepProps) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [typed, setTyped] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => cancel.current?.focus(), []);

  const acknowledgements = ceremony?.acknowledgements ?? [];
  const expected = level === "typed" || level === "ceremony" ? ceremony?.typed : undefined;
  const ready =
    !busy && acknowledgements.every((a) => ticked.has(a.id)) && (expected === undefined || typed.trim() === expected);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div onKeyDown={onKeyDown} className="flex flex-col gap-3 px-6 pt-5 text-dense text-foreground">
      <p id={`${id}-statement`}>{ceremony?.statement ?? title}</p>
      {ceremony && ceremony.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {ceremony.facts.map((fact, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd>{fact.value.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {ceremony && ceremony.warnings.length > 0 && (
        <ul className="rounded-md bg-warning-muted px-3 py-2 text-warning-fg">
          {ceremony.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
      {acknowledgements.map((a) => (
        <label key={a.id} className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={ticked.has(a.id)}
            disabled={busy}
            onChange={(event) => {
              if (!isTrusted(event)) return;
              const next = new Set(ticked);
              if (event.target.checked) next.add(a.id);
              else next.delete(a.id);
              setTicked(next);
            }}
          />
          <span>{a.label}</span>
        </label>
      ))}
      {expected !== undefined && (
        <label className="flex flex-col gap-1">
          <span className="text-caption font-medium">
            Type <strong>{expected}</strong> to confirm
          </span>
          <input
            type="text"
            value={typed}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-md border border-border bg-card px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              if (isTrusted(event)) setTyped(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-destructive-muted px-3 py-2.5 text-destructive-fg">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 -mx-6 flex flex-wrap justify-end gap-2 bg-muted px-6 py-3">
        <button ref={cancel} type="button" className={`${BUTTON} border-transparent`} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready}
          aria-describedby={`${id}-statement`}
          className={`${BUTTON} ${tone === "danger" ? "border-destructive bg-destructive text-destructive-foreground" : "border-primary bg-primary text-primary-foreground"}`}
          onClick={(event) => {
            if (!ready || !isTrusted(event)) return;
            onConfirm({
              ...(ceremony?.digest === undefined ? {} : { digest: ceremony.digest }),
              acknowledged: acknowledgements.filter((a) => ticked.has(a.id)).map((a) => a.id),
              ...(expected === undefined ? {} : { typed: typed.trim() }),
            });
          }}
        >
          {title}
        </button>
      </div>
    </div>
  );
}
