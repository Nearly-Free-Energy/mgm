"use client";

/**
 * The kit's form for a prepared action's input, which the action host uses
 * whenever the GUI brings no form of its own. It renders the JSON Schema in
 * ActionSpec.input: flat fields (text, secret, date, number, whole number,
 * yes/no, a choice) and arrays of flat objects as rows. Any other shape gets
 * a notice and Cancel only, never a partial form.
 *
 * It never fetches or writes. Its own button hands a copy of the values to
 * the host through `submit`. For a one-step confirm the host passes its own
 * footer, which replaces that button, and reads the values through `bind`
 * when the host's Confirm is pressed; Enter then submits nothing.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { FormProps, Json } from "../contract";

type Kind = "text" | "secret" | "date" | "number" | "integer" | "boolean" | "choice";
interface Flat {
  kind: Kind;
  key: string;
  label: string;
  hint?: string;
  required: boolean;
  nullable: boolean;
  choices?: (string | number)[];
  min?: number;
  max?: number;
  maxLength?: number;
  fallback?: Json;
}
interface Rows {
  kind: "rows";
  key: string;
  label: string;
  hint?: string;
  fields: Flat[];
  minItems: number;
  maxItems: number;
  fallback?: Json;
}
export type Field = Flat | Rows;

type Raw = string | boolean;
type Row = { id: number; cells: Record<string, Raw> };
type Values = Record<string, Raw | Row[]>;

export const NO_FORM = "This action needs a form this interface does not offer.";
const MAX_ROWS = 100;
const OBJECT_KEYS = new Set(["$schema", "type", "properties", "required", "additionalProperties", "title", "description"]);

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: Json | undefined) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const num = (v: Json | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const humanise = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
/** Keys an object schema may carry; extra properties only when they admit nothing to render. */
const plainObject = (node: Record<string, Json>) =>
  Object.keys(node).every((k) => OBJECT_KEYS.has(k)) &&
  (!isObject(node.additionalProperties) || Object.keys(node.additionalProperties).length === 0);
const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** Labels come from `title`, then `description`, then the key. */
const named = (key: string, node: Record<string, Json>) => ({
  label: text(node.title) ?? text(node.description) ?? humanise(key),
  hint: text(node.title) ? text(node.description) : undefined,
});

function flatOf(key: string, node: Json, required: boolean): Flat | null {
  if (!isObject(node)) return null;
  let at = node;
  let nullable = false;
  if (Array.isArray(node.anyOf)) {
    // Only "this or null", as zod writes a nullable field.
    const { anyOf, ...outer } = node;
    const [only, ...others] = anyOf.filter((m) => !(isObject(m) && m.type === "null"));
    if (anyOf.length !== 2 || others.length > 0 || !isObject(only) || Array.isArray(only.anyOf)) return null;
    at = { ...only, ...outer };
    nullable = true;
  }
  const base = { key, ...named(key, at), required, nullable, fallback: at.default };
  if (Array.isArray(at.enum)) {
    const choices = at.enum.filter((c): c is string | number => typeof c === "string" || typeof c === "number");
    return choices.length > 0 && choices.length === at.enum.length ? { ...base, kind: "choice", choices } : null;
  }
  switch (at.type) {
    case "string": {
      const kind = at.writeOnly === true ? "secret" : at.format === "date" ? "date" : "text";
      return { ...base, kind, maxLength: num(at.maxLength) };
    }
    case "number":
    case "integer":
      return { ...base, kind: at.type, min: num(at.minimum), max: num(at.maximum) };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      return null;
  }
}

/** The fields an object schema's properties hold, or null when one is not flat. */
function flatFields(node: Record<string, Json>): Flat[] | null {
  if (node.type !== "object" || !isObject(node.properties)) return null;
  if (!plainObject(node)) return null;
  const required = strings(node.required);
  const fields: Flat[] = [];
  for (const [key, field] of Object.entries(node.properties)) {
    const flat = flatOf(key, field, required.includes(key));
    if (!flat) return null;
    fields.push(flat);
  }
  return fields;
}

/** The fields this form renders for `input`, or null when it cannot render every one of them. */
export function fieldsOf(input: Json): Field[] | null {
  if (!isObject(input) || input.type !== "object" || !isObject(input.properties)) return null;
  if (!plainObject(input)) return null;
  const required = strings(input.required);
  const fields: Field[] = [];
  for (const [key, node] of Object.entries(input.properties)) {
    if (isObject(node) && node.type === "array") {
      const inner = isObject(node.items) ? flatFields(node.items) : null;
      if (!inner || inner.length === 0) return null;
      const minItems = Math.min(num(node.minItems) ?? 0, MAX_ROWS);
      const maxItems = Math.max(minItems, Math.min(num(node.maxItems) ?? MAX_ROWS, MAX_ROWS));
      fields.push({ kind: "rows", key, ...named(key, node), fields: inner, minItems, maxItems, fallback: node.default });
    } else {
      const flat = flatOf(key, node, required.includes(key));
      if (!flat) return null;
      fields.push(flat);
    }
  }
  return fields;
}

let lastRow = 0;
const nextRow = () => (lastRow += 1);

function rawOf(field: Flat, given: Json | undefined): Raw {
  const v = given === undefined ? field.fallback : given;
  if (field.kind === "secret") return "";
  if (field.kind === "boolean") return v === true;
  if (field.kind === "choice") {
    const i = field.choices!.findIndex((c) => c === v);
    return i < 0 ? "" : String(i);
  }
  if (typeof v === "number" && (field.kind === "number" || field.kind === "integer")) return String(v);
  return typeof v === "string" ? v : "";
}

function rowOf(fields: Flat[], item: Json | undefined): Row {
  return { id: nextRow(), cells: Object.fromEntries(fields.map((f) => [f.key, rawOf(f, isObject(item) ? item[f.key] : undefined)])) };
}

function startOf(fields: Field[], initial: Json | null): Values {
  const given = isObject(initial) ? initial : {};
  return Object.fromEntries(
    fields.map((field) => {
      if (field.kind !== "rows") return [field.key, rawOf(field, given[field.key])];
      const list = Array.isArray(given[field.key]) ? given[field.key] : Array.isArray(field.fallback) ? field.fallback : [];
      const rows = (list as Json[]).slice(0, field.maxItems).map((item) => rowOf(field.fields, item));
      while (rows.length < field.minItems) rows.push(rowOf(field.fields, undefined));
      return [field.key, rows];
    }),
  );
}

/** One field's value, or its error; `{}` leaves an optional empty field out. */
function valueOf(field: Flat, raw: Raw): { value?: Json; error?: string } {
  if (field.kind === "boolean") return { value: raw === true };
  const typed = typeof raw === "string" ? raw : "";
  if ((field.kind === "secret" ? typed : typed.trim()) === "") {
    if (field.nullable) return { value: null };
    return field.required ? { error: field.kind === "choice" ? "Choose an option." : "Enter a value." } : {};
  }
  if (field.kind === "choice") return { value: field.choices![Number(typed)] ?? null };
  if (field.kind === "number" || field.kind === "integer") {
    const n = Number(typed.trim());
    if (!Number.isFinite(n)) return { error: "Enter a number." };
    if (field.kind === "integer" && !Number.isInteger(n)) return { error: "Enter a whole number." };
    if (field.min !== undefined && n < field.min) return { error: `Enter ${field.min} or more.` };
    if (field.max !== undefined && n > field.max) return { error: `Enter ${field.max} or less.` };
    return { value: n };
  }
  return { value: typed };
}

/** The body to send, or the errors by path ("name", "bands.0.rate"). */
function collect(fields: Field[], values: Values): { body: Record<string, Json>; errors: Record<string, string> } {
  const body: Record<string, Json> = {};
  const errors: Record<string, string> = {};
  const put = (field: Flat, raw: Raw, path: string, into: Record<string, Json>) => {
    const { value, error } = valueOf(field, raw);
    if (error) errors[path] = error;
    else if (value !== undefined) into[field.key] = value;
  };
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind !== "rows") put(field, value as Raw, field.key, body);
    else
      body[field.key] = (value as Row[]).map((row, i) => {
        const item: Record<string, Json> = {};
        for (const cell of field.fields) put(cell, row.cells[cell.key], `${field.key}.${i}.${cell.key}`, item);
        return item;
      });
  }
  return { body, errors };
}

const BUTTON =
  "inline-flex min-h-8 items-center rounded-md border px-3.5 text-dense font-medium pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";
const QUIET = `${BUTTON} border-transparent text-foreground hover:bg-muted`;
const CONTROL =
  "h-9 w-full rounded-md border border-border bg-card px-3 text-dense text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-[invalid=true]:border-destructive";

export interface ActionFormProps extends FormProps {
  /** The host's footer for a one-step confirm; it replaces the form's own button. */
  footer?: ReactNode;
  /** Gives the host the function that checks and reads the values; null on unmount. */
  bind?(read: (() => Json | null) | null): void;
}

export function ActionForm({ spec, initial, busy, error, submit, cancel, footer, bind }: ActionFormProps) {
  const [fields] = useState(() => fieldsOf(spec.input));
  const [values, setValues] = useState<Values>(() => (fields ? startOf(fields, initial) : {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  /** What to focus after the next render: an element id, or the first field in error. */
  const focusNext = useRef<{ id: string } | "invalid" | null>(null);
  const id = useId();

  /** Checks the values; shows what is wrong and returns null, or returns the body. */
  const read = (): Json | null => {
    if (!fields) return null;
    const out = collect(fields, values);
    setErrors(out.errors);
    if (Object.keys(out.errors).length === 0) return out.body;
    focusNext.current = "invalid";
    return null;
  };
  useLayoutEffect(() => {
    bind?.(read);
  });
  useLayoutEffect(() => () => bind?.(null), [bind]);
  useEffect(() => (form.current ?? notice.current)?.querySelector<HTMLElement>("input, select, button")?.focus(), []);
  // The route's field error takes focus, so it is heard as well as seen: its
  // field or row cell, or the first control of the array it names.
  useEffect(() => {
    const path = error?.field;
    const owner = path && fields?.find((f) => path === f.key || path.startsWith(`${f.key}.`));
    const doc = form.current?.ownerDocument;
    if (!owner || !doc) return;
    const at =
      doc.getElementById(`${id}-${path}`) ??
      doc.getElementById(`${id}-${owner.key}-rows`)?.querySelector<HTMLElement>("input, select, button:enabled");
    at?.focus();
  }, [error, fields, id]);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "invalid") form.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    else if (target) form.current?.ownerDocument.getElementById(target.id)?.focus();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    cancel();
  };
  if (!fields) {
    return (
      <div onKeyDown={onKeyDown} ref={notice} className="flex flex-col gap-3 pt-4 text-dense text-foreground">
        <p className="px-6">{NO_FORM}</p>
        <DialogFooter>
          <button type="button" className={QUIET} onClick={cancel}>
            Cancel
          </button>
        </DialogFooter>
      </div>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (footer || busy) return;
    const body = read();
    if (body !== null) submit(body);
  };
  const set = (key: string, raw: Raw | Row[]) => setValues((prev) => ({ ...prev, [key]: raw }));
  // The route's error shows at its field: a field's key, or a row's cell ("bands.0.rate").
  const serverField = error?.field;
  const placed = fields.some((f) => serverField === f.key || serverField?.startsWith(`${f.key}.`));
  const errorAt = (path: string) => errors[path] ?? (serverField === path ? error!.message : undefined);

  const control = (field: Flat, raw: Raw, path: string, onChange: (raw: Raw) => void) => {
    const inputId = `${id}-${path}`;
    const problem = errorAt(path);
    const described = [field.hint && `${inputId}-hint`, problem && `${inputId}-error`].filter(Boolean).join(" ") || undefined;
    const common = {
      id: inputId,
      disabled: busy,
      "aria-invalid": problem ? true : undefined,
      "aria-required": field.required || undefined,
      "aria-describedby": described,
    };
    const input =
      field.kind === "boolean" ? (
        <input {...common} type="checkbox" checked={raw === true} onChange={(e) => onChange(e.currentTarget.checked)} />
      ) : field.kind === "choice" ? (
        <select {...common} className={CONTROL} value={String(raw)} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">Choose…</option>
          {field.choices!.map((choice, i) => (
            <option key={i} value={String(i)}>
              {String(choice)}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          className={CONTROL}
          value={String(raw)}
          onChange={(e) => onChange(e.currentTarget.value)}
          type={field.kind === "secret" ? "password" : field.kind === "date" ? "date" : "text"}
          autoComplete={field.kind === "secret" ? "new-password" : undefined}
          inputMode={field.kind === "number" ? "decimal" : field.kind === "integer" ? "numeric" : undefined}
          maxLength={field.maxLength}
        />
      );
    const mark = field.required && <span aria-hidden="true"> *</span>;
    return (
      <div key={path} className="flex min-w-0 flex-col gap-1">
        {field.kind === "boolean" ? (
          <label htmlFor={inputId} className="flex items-center gap-2">
            {input}
            <span>
              {field.label}
              {mark}
            </span>
          </label>
        ) : (
          <>
            <label htmlFor={inputId} className="text-caption font-medium">
              {field.label}
              {mark}
            </label>
            {input}
          </>
        )}
        {field.hint && (
          <p id={`${inputId}-hint`} className="text-caption text-muted-foreground">
            {field.hint}
          </p>
        )}
        {problem && (
          <p id={`${inputId}-error`} className="text-caption text-destructive-fg">
            {problem}
          </p>
        )}
      </div>
    );
  };

  const rows = (field: Rows) => {
    const list = values[field.key] as Row[];
    const inCell = list.some((_, i) => field.fields.some((c) => serverField === `${field.key}.${i}.${c.key}`));
    const problem = errors[field.key] ?? (!inCell && (serverField === field.key || serverField?.startsWith(`${field.key}.`)) ? error!.message : undefined);
    const addId = `${id}-${field.key}-add`;
    const removeId = (row: Row) => `${id}-${field.key}-remove-${row.id}`;
    const add = () => {
      focusNext.current = { id: `${id}-${field.key}.${list.length}.${field.fields[0].key}` };
      set(field.key, [...list, rowOf(field.fields, undefined)]);
    };
    // Focus moves to the next row's Remove, else the previous row's, else Add.
    const remove = (i: number) => {
      const rest = list.filter((_, j) => j !== i);
      const near = rest[i] ?? rest[i - 1];
      focusNext.current = { id: near && rest.length > field.minItems ? removeId(near) : addId };
      set(field.key, rest);
    };
    const problemId = `${id}-${field.key}-error`;
    return (
      <fieldset key={field.key} id={`${id}-${field.key}-rows`} aria-describedby={problem ? problemId : undefined} className="flex flex-col gap-2">
        <legend className="text-caption font-medium">{field.label}</legend>
        {field.hint && <p className="text-caption text-muted-foreground">{field.hint}</p>}
        {list.map((row, i) => (
          <div key={row.id} role="group" aria-label={`${field.label}, row ${i + 1}`} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
            {field.fields.map((cell) =>
              control(cell, row.cells[cell.key], `${field.key}.${i}.${cell.key}`, (raw) =>
                set(field.key, list.map((r) => (r.id === row.id ? { ...r, cells: { ...r.cells, [cell.key]: raw } } : r))),
              ),
            )}
            <button
              type="button"
              id={removeId(row)}
              className={QUIET}
              disabled={busy || list.length <= field.minItems}
              aria-label={`Remove ${field.label}, row ${i + 1}`}
              onClick={() => remove(i)}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button type="button" id={addId} className={`${BUTTON} border-border bg-card text-foreground hover:bg-muted`} disabled={busy || list.length >= field.maxItems} onClick={add}>
            Add a row to {field.label}
          </button>
        </div>
        {problem && (
          <p id={problemId} role="alert" className="text-caption text-destructive-fg">
            {problem}
          </p>
        )}
      </fieldset>
    );
  };

  return (
    <form ref={form} noValidate onSubmit={onSubmit} onKeyDown={onKeyDown} className="flex flex-col gap-3 pt-4 text-dense text-foreground">
      <div className="flex flex-col gap-3 px-6">
        {fields.map((field) =>
          field.kind === "rows" ? rows(field) : control(field, values[field.key] as Raw, field.key, (raw) => set(field.key, raw)),
        )}
        {error && !placed && (
          <p role="alert" className="rounded-md bg-destructive-muted px-3 py-2.5 text-destructive-fg">
            {error.message}
          </p>
        )}
      </div>
      {footer ?? (
        <DialogFooter>
          <button type="button" className={QUIET} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={cn(BUTTON, "border-primary bg-primary text-primary-foreground")}>
            {spec.confirm === "none" ? spec.title : "Continue"}
          </button>
        </DialogFooter>
      )}
    </form>
  );
}
