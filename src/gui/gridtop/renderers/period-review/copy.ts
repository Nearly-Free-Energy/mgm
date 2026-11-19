/**
 * Copying a figure: the clipboard write, and the state the table, the cards
 * and the totals share, which says what was copied and marks the copied
 * control for a moment.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** What a failed copy announces: which figure, and the figure itself, since the text shown is grouped or rounded. */
export const copyFailed = (what: string, figure: string) => `Could not copy ${what}: the clipboard is not available. The figure is ${figure}.`;
/** How long a copied figure stays marked. */
const PULSE_MS = 900;

/** Writes `figure` to the clipboard; false when there is none or the write is refused. Never logs. */
export async function copyFigure(figure: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(figure);
    return true;
  } catch {
    return false;
  }
}

export type Copier = {
  /** The control last copied from, while it is marked. */
  copied: string | null;
  /**
   * Copies `figure`, announces "<what>, copied <figure>", and marks `id`;
   * announces the failure, naming `what`, instead. Resolves to whether the
   * figure reached the clipboard.
   */
  copy(id: string, figure: string, what: string, after?: string): Promise<boolean>;
};

export function useCopier(announce: (message: string) => void): Copier {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (id: string, figure: string, what: string, after?: string) => {
      const ok = await copyFigure(figure);
      if (timer.current) clearTimeout(timer.current);
      if (!ok) {
        setCopied(null);
        announce(copyFailed(what, figure));
        return false;
      }
      setCopied(id);
      timer.current = setTimeout(() => setCopied(null), PULSE_MS);
      announce(`${what}, copied ${figure}${after ? `. ${after}` : ""}`);
      return true;
    },
    [announce],
  );
  return { copied, copy };
}
