"use client";

/**
 * The confirmation step before a write, owned by the host (decision 5 on
 * #115): a GUI frames it in its Overlay but never supplies, sees or alters
 * it. A tick, a keystroke in the typed name or a click on Confirm counts
 * only when it is real input the browser is dispatching at that very control
 * (./trusted.ts); checked state and text are read from the control itself.
 * Each one is handed to the host with its event and control, and the host
 * checks it again and keeps its own record, which is what it sends: this
 * component's state only decides what is shown and when Confirm is enabled.
 * Confirm is the only thing that calls onConfirm: nothing submits on mount,
 * on Enter or on a tick.
 *
 * ConfirmFooter is the Cancel and Confirm row on its own. action-host.tsx
 * also renders it as the kit form's footer for a one-step confirm, with the
 * same Confirm button and the same click check; a change here changes both,
 * as long as the host keeps using it there.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Ceremony } from "../../contract";
import { isLiveEventOn, isTrusted, readInput, TICK_EVENTS, TYPING_EVENTS } from "./trusted";

export interface ConfirmStepProps {
  level: "confirm" | "typed" | "ceremony";
  title: string;
  tone: "neutral" | "danger";
  ceremony: Ceremony | null;
  busy: boolean;
  error: string | null;
  /** Called on a real click of Confirm, with that click; the host builds the confirmation itself. */
  onConfirm(event: MouseEvent<HTMLButtonElement>): void;
  /** Called on a real change of an acknowledgement's checkbox, with that change and the checkbox. */
  onTick(id: string, event: ChangeEvent<HTMLInputElement>, input: HTMLInputElement): void;
  /** Called on real typing in the typed name, with that change and the text input. */
  onType(event: ChangeEvent<HTMLInputElement>, input: HTMLInputElement): void;
  onCancel(): void;
  /** The Confirm button, for the host's own check of the click. */
  confirmRef?: Ref<HTMLButtonElement>;
}

const BUTTON =
  "inline-flex min-h-8 items-center rounded-md border px-3.5 text-dense font-medium pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export interface ConfirmFooterProps {
  title: string;
  tone: "neutral" | "danger";
  /** Whether Confirm may be pressed. */
  ready: boolean;
  /** The id of the text Confirm is described by. */
  describedBy?: string;
  onConfirm(event: MouseEvent<HTMLButtonElement>): void;
  onCancel(): void;
  confirmRef?: Ref<HTMLButtonElement>;
  cancelRef?: Ref<HTMLButtonElement>;
  className?: string;
}

/** Cancel, and Confirm labelled with the action's title; Confirm calls onConfirm only on a real click while ready. */
export function ConfirmFooter({ title, tone, ready, describedBy, onConfirm, onCancel, confirmRef, cancelRef, className }: ConfirmFooterProps) {
  return (
    <DialogFooter className={className}>
      <button ref={cancelRef} type="button" className={`${BUTTON} border-transparent`} onClick={onCancel}>
        Cancel
      </button>
      <button
        ref={confirmRef}
        type="button"
        disabled={!ready}
        aria-describedby={describedBy}
        className={cn(BUTTON, tone === "danger" ? "border-destructive bg-destructive text-destructive-foreground" : "border-primary bg-primary text-primary-foreground")}
        onClick={(event) => {
          if (ready && isTrusted(event)) onConfirm(event);
        }}
      >
        {title}
      </button>
    </DialogFooter>
  );
}

export function ConfirmStep({
  level,
  title,
  tone,
  ceremony,
  busy,
  error,
  onConfirm,
  onTick,
  onType,
  onCancel,
  confirmRef,
}: ConfirmStepProps) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [typed, setTyped] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  /** Each acknowledgement's checkbox, by id, and the typed-name input. */
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const text = useRef<HTMLInputElement>(null);
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
            ref={(box) => {
              if (box) boxes.current.set(a.id, box);
              else boxes.current.delete(a.id);
            }}
            checked={ticked.has(a.id)}
            disabled={busy}
            onChange={(event) => {
              const box = boxes.current.get(a.id) ?? null;
              if (!box || !isTrusted(event) || !isLiveEventOn(event, box, TICK_EVENTS)) return;
              const next = new Set(ticked);
              if (readInput(box).checked) next.add(a.id);
              else next.delete(a.id);
              setTicked(next);
              onTick(a.id, event, box);
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
            ref={text}
            type="text"
            value={typed}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-md border border-border bg-card px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              const input = text.current;
              if (!input || !isTrusted(event) || !isLiveEventOn(event, input, TYPING_EVENTS)) return;
              setTyped(readInput(input).value);
              onType(event, input);
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
      <ConfirmFooter
        className="-mx-6"
        title={title}
        tone={tone}
        ready={ready}
        describedBy={`${id}-statement`}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmRef={confirmRef}
        cancelRef={cancel}
      />
    </div>
  );
}
