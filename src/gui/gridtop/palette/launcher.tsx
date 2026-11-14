/**
 * What opens the command palette: the search button in the title bar, and
 * ⌘K or Ctrl+K anywhere on the page. The only shortcut Gridtop has: no
 * single-key shortcuts (decision 14 on #115). The palette itself
 * (./palette.tsx, with cmdk) loads on the first open. Like the sheets, it is
 * open for one pathname only. If that load fails (a tab left open across a
 * deploy asks for a chunk that is gone, or the device is offline), nothing is
 * shown and the next open tries again.
 */
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { kit } from "@/lib/gui/kit";
import { TRAY_BUTTON } from "../shell/tray-parts";

type PaletteModule = typeof import("./palette");
type PaletteComponent = PaletteModule["Palette"];
const loadPalette = (): Promise<PaletteModule> => import("./palette");

/**
 * ⌘K or Ctrl+K, and not a key that confirms text an input method is composing.
 * Some browsers send keydown with no `key` when a field is autofilled.
 */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || typeof event.key !== "string") return false;
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

export function PaletteLauncher({ load = loadPalette }: { load?: () => Promise<PaletteModule> }) {
  const pathname = kit.usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  // The palette's component once its chunk has loaded. Loaded by hand rather
  // than with React.lazy, which keeps a failed load failed for good.
  const [Palette, setPalette] = useState<PaletteComponent | null>(null);
  const loading = useRef(false);
  // Where focus goes back to once the palette closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  if (openOn !== null && openOn !== pathname) setOpenOn(null);
  const open = openOn === pathname;
  const ensureLoaded = useCallback(() => {
    if (Palette || loading.current) return;
    loading.current = true;
    load()
      .then(
        (module) => setPalette(() => module.Palette),
        // Nothing to show: close, and let the next open try again.
        () => setOpenOn(null),
      )
      .finally(() => {
        loading.current = false;
      });
  }, [Palette, load]);
  const setOpen = (next: boolean) => {
    if (next) ensureLoaded();
    setOpenOn(next ? pathname : null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      if (!open) {
        const active = document.activeElement;
        returnFocus.current = active instanceof HTMLElement ? active : null;
      }
      if (!open) ensureLoaded();
      setOpenOn(open ? null : pathname);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pathname, ensureLoaded]);

  return (
    <>
      <button
        type="button"
        aria-label="Go to or find"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        aria-expanded={open}
        className={TRAY_BUTTON}
        onClick={(event) => {
          returnFocus.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <Search aria-hidden="true" focusable="false" className="gt:size-5" />
      </button>
      {Palette && <Palette open={open} onOpenChange={setOpen} returnFocus={returnFocus} />}
    </>
  );
}
