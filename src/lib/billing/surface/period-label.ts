/**
 * A billing period as the host labels it in a trail and an entity
 * (src/lib/gui/host/server/entities.ts): if the host's label changes, so
 * should this. Shared by the period review and the period history, so the
 * two models and the host name a period alike.
 */
import type { Fmt } from "@/lib/gui/surface";

export function periodLabel(fmt: Fmt, start: string, end: string): string {
  return `${fmt.date(start).text} – ${fmt.date(end).text}`;
}
