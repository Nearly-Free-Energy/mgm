/**
 * The part of the `billing.send-queue@1` ext this renderer reads: each
 * row's payment link and the readiness note. The host has already parsed
 * the ext strictly against its schema (SendQueueExt in
 * src/lib/billing/surface/send-queue-ext.ts, which a GUI package may not
 * import; billing registers it as the view's ext.zod in
 * src/lib/billing/surface.ts, and compile in src/lib/gui/host/server/parse.ts
 * parses every model's ext against it), so this only checks what the
 * renderer relies on: one entry per model row, with the row's id, and a link
 * exactly where the row's link cell shows one. If the view stops declaring
 * that schema, or the host stops parsing an ext before a GUI receives it,
 * check the url's length and the note's size here too. A change to that
 * schema is version 2, which this renderer does not read.
 */
import type { Json, Tone, ViewModel } from "@/lib/gui/contract";

export const SEND_QUEUE_EXT = "billing.send-queue@1";
/** The model's cell holding the link as text. */
export const LINK_KEY = "link";

export type SendQueueLinks = {
  /** One per model row, in the same order: the link to copy, or null. */
  urls: (string | null)[];
  note: { tone: Extract<Tone, "info" | "warning">; text: string } | null;
};

const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** The links and note, or null when the model is not this view at version 1 or they do not line up with its rows. */
export function readSendQueueExt(model: ViewModel): SendQueueLinks | null {
  if (model.kind !== "collection" || model.ext?.schema !== SEND_QUEUE_EXT) return null;
  const d = model.ext.data;
  if (!isObject(d) || !Array.isArray(d.rows)) return null;
  const { rows } = model.body;
  if (d.rows.length !== rows.length) return null;
  const urls: (string | null)[] = [];
  for (const [i, row] of d.rows.entries()) {
    if (!isObject(row) || row.id !== rows[i].id) return null;
    const url = row.url;
    if (url !== null && (typeof url !== "string" || !/^https?:\/\//.test(url))) return null;
    // The cell a GUI without this renderer shows must be the same link.
    const cell = rows[i].cells[LINK_KEY];
    if (url === null ? cell?.t === "text" : cell?.t !== "text" || cell.text !== url) return null;
    urls.push(url);
  }
  let note: SendQueueLinks["note"] = null;
  if (d.note !== null && d.note !== undefined) {
    if (!isObject(d.note) || typeof d.note.text !== "string" || (d.note.tone !== "info" && d.note.tone !== "warning")) return null;
    note = { tone: d.note.tone, text: d.note.text };
  }
  return { urls, note };
}
