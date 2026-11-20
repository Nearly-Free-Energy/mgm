import "server-only";

/**
 * The loader of Today (`org.today`, ./today-model.ts). It reads nothing
 * itself: the view declares `takesSignals`, so the host has collected the
 * organization's signals, each watcher with the person's own session and
 * only while its plugin is on, before this runs, and hands them over as
 * `req.signals` (null when they could not be collected).
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { buildTodayModel } from "./today-model";

export async function loadToday(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  return { ok: true, model: buildTodayModel(req.fmt, req.signals ?? null) };
}
