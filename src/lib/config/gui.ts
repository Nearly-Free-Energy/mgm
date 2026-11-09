import "server-only";

/**
 * `MGM_GUI`: which compiled-in GUI (src/gui/meta.ts) serves this
 * installation's pages. Unset or blank selects Gridtop.
 *
 * Read per call, like the other settings (ADR-003), and never sent to the
 * browser: no-browser-env-config.test.ts keeps browser files from reading it
 * or importing this module. If a client component starts receiving the
 * setting, send only readGuiName()'s result and revisit that test.
 * Errors name the variable; the value is quoted only when it has the shape of
 * a GUI name, so a value pasted into the wrong variable is never printed.
 */
import { GUI_META, type GuiName } from "@/gui/meta";
import { GUI_CONTRACT } from "@/lib/gui/contract";
import { guiMetaSchema } from "@/lib/gui/host/server/model-schema";
import { satisfiesContract } from "@/lib/gui/host/shared/contract-range";
import type { RuntimeEnv } from "./public-runtime-config";

export const DEFAULT_GUI: GuiName = "gridtop";

export class GuiSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuiSettingError";
  }
}

const hasGuiNameShape = (value: string): boolean =>
  guiMetaSchema.shape.name.safeParse(value).success;

const installed = (): GuiName[] => Object.keys(GUI_META) as GuiName[];

function isInstalled(value: string): value is GuiName {
  return Object.hasOwn(GUI_META, value);
}

/**
 * The GUI `MGM_GUI` selects. Throws GuiSettingError when it names no
 * compiled-in GUI, or when that GUI does not support this build's contract.
 * The runtime root also refuses to install a compiled-in GUI whose range
 * excludes this build (SurfaceRegistry.install), so the second error is not
 * normally reached in a running server; if that install check is removed,
 * this becomes the only one.
 */
export function readGuiName(env: RuntimeEnv = process.env): GuiName {
  const value = env.MGM_GUI?.trim();
  if (!value) return DEFAULT_GUI;
  if (!isInstalled(value)) {
    const named = hasGuiNameShape(value) ? ` "${value}"` : "";
    throw new GuiSettingError(
      `MGM_GUI${named} names no installed GUI. Installed: ${installed().join(", ")}.`,
    );
  }
  const meta = GUI_META[value];
  if (!satisfiesContract(GUI_CONTRACT, meta.contract)) {
    throw new GuiSettingError(
      `MGM_GUI selects ${meta.name} ${meta.version}, which supports GUI contract ${meta.contract}; this build provides ${GUI_CONTRACT}.`,
    );
  }
  return value;
}

/**
 * The start-up check (src/instrumentation.ts): throws the error readGuiName
 * would, so it is logged once when the server starts.
 */
export function validateGuiAtStartup(env: RuntimeEnv = process.env): void {
  readGuiName(env);
}
