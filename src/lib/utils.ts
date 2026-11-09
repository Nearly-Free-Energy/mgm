// utils.ts — the class-name helper.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale: each name is a `--text-<name>` size in the `@theme` block
 * of src/app/globals.css and a `text-<name>` utility.
 *
 * tailwind-merge reads an unknown `text-<name>` as a text colour, so without
 * this list `cn("text-caption text-muted-foreground")` drops the size, with
 * no error. The elevation and radius names are listed so that a later
 * shadow or radius class replaces them, as it does Tailwind's own sizes.
 * These lists name the `--text-*`, `--shadow-*` and `--radius-*` variables
 * globals.css adds beyond Tailwind's defaults (sm, md, lg and xl radii are
 * known already); if one is added or renamed there, change it here.
 * src/lib/__tests__/design-tokens.test.ts fails until both agree.
 */
export const TYPE_SCALE = ["caption", "dense", "body", "title", "headline", "kpi"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...TYPE_SCALE],
      shadow: ["elev-1", "elev-2", "elev-3"],
      radius: ["pill"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
