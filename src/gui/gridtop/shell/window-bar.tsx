/**
 * The window bar above a contributed view: its title and subtitle, its tabs
 * as links, its actions and its links. Only a page served through a view has
 * a model, so pages outside the contract show none and keep their own
 * heading and tabs (decision 11 on #115).
 *
 * Every write goes through kit.act, which runs the form, the confirmation
 * and the request; a disabled action shows why instead. Links open through
 * kit.open. Below 600 px it is one 44 px bar: the title opens the tabs, ⋯
 * opens the actions and links, and it slides away while `main` scrolls down.
 */
import { ChevronDown, Ellipsis } from "lucide-react";
import { useEffect, useId, useState, type RefObject } from "react";
import type { ActionRef, Href, LinkRef, ViewModel, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { openable } from "../ui/href";
import { SHEET_ROW, Sheet } from "../ui/sheet";

type Tab = { title: string; href: Href; current: boolean };

const CONTROL =
  "gt:inline-flex gt:h-8 gt:items-center gt:gap-2 gt:rounded-md gt:border gt:px-3 gt:text-dense gt:font-medium " +
  "gt:pointer-coarse:h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:disabled:cursor-not-allowed gt:disabled:opacity-60";

const BAR_BUTTON =
  "gt:inline-flex gt:h-11 gt:shrink-0 gt:items-center gt:justify-center gt:gap-1 gt:rounded-md gt:px-2 " +
  "gt:hover:bg-muted gt:aria-expanded:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

const TAB =
  "gt:block gt:border-b-2 gt:border-transparent gt:px-2 gt:leading-8 gt:text-dense gt:text-muted-foreground gt:hover:text-foreground " +
  "gt:pointer-coarse:leading-11 gt:aria-[current=page]:border-primary gt:aria-[current=page]:font-medium gt:aria-[current=page]:text-foreground " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

/** How far `main` scrolls before the compact bar may slide away: its own height. */
const BAR_HEIGHT = 44;

const samePage = (href: Href, pathname: string) => href.split(/[?#]/, 1)[0] === pathname;

/** The page's own tabs, then the views attached as tabs, each once. */
export function tabsOf(view: Pick<ViewState, "tabs">, model: ViewModel, pathname: string): Tab[] {
  const tabs: Tab[] = [...view.tabs];
  for (const attached of model.attached) {
    if (attached.hint !== "tab" || tabs.some((t) => t.href === attached.href)) continue;
    tabs.push({ title: attached.title, href: attached.href, current: samePage(attached.href, pathname) });
  }
  return tabs;
}

/**
 * Whether `main` is scrolling down past the bar; scrolling up brings it back,
 * and so does focus moving into it, so a focused control is never off screen.
 */
function useScrolledAway(main: RefObject<HTMLElement | null>, active: boolean): [boolean, () => void] {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = main.current;
    if (!el || !active) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const y = el.scrollTop;
      if (y > last && y > BAR_HEIGHT) setAway(true);
      else if (y < last) setAway(false);
      last = y;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [main, active]);
  return [active && away, () => setAway(false)];
}

function ActionControl(props: { actionRef: ActionRef; onResult(message: string | null): void; className: string }) {
  const { actionRef, onResult, className } = props;
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    onResult(null);
    const result = await kit.act(actionRef);
    setBusy(false);
    if (!result.ok && result.code !== "cancelled") onResult(result.message);
  };
  const disabled = !actionRef.enabled;
  return (
    <span className="gt:inline-flex gt:flex-col gt:gap-1">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={disabled && actionRef.reason ? reasonId : undefined}
        data-closes-sheet={disabled ? undefined : ""}
        className={cx(
          className,
          actionRef.tone === "danger"
            ? "gt:border-destructive gt:bg-destructive-muted gt:text-destructive-fg"
            : "gt:border-border gt:bg-card gt:text-foreground gt:hover:bg-muted",
          actionRef.provenance && "gt:border-dashed",
        )}
      >
        {actionRef.provenance && <span className="gt:text-caption gt:font-semibold gt:text-muted-foreground">Proposed</span>}
        {actionRef.label}
      </button>
      {disabled && actionRef.reason && (
        <span id={reasonId} className="gt:text-caption gt:text-muted-foreground">
          {actionRef.reason}
        </span>
      )}
    </span>
  );
}

function LinkControl({ link, className }: { link: LinkRef; className: string }) {
  if (!openable(link.href)) return <span className={className}>{link.label}</span>;
  return (
    <a
      href={link.href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void kit.open(link);
      }}
    >
      {link.label}
    </a>
  );
}

function Controls(props: { model: ViewModel; onResult(message: string | null): void; inSheet: boolean }) {
  const { model, onResult, inSheet } = props;
  const action = inSheet ? cx(CONTROL, "gt:min-h-11 gt:w-full") : CONTROL;
  const link = inSheet ? SHEET_ROW : cx(CONTROL, "gt:border-transparent gt:text-primary gt:hover:underline");
  return (
    <ul className={inSheet ? "gt:flex gt:flex-col gt:gap-2" : "gt:flex gt:flex-wrap gt:items-start gt:justify-end gt:gap-2"}>
      {model.actions.map((ref, i) => (
        <li key={`${ref.action}-${i}`}>
          <ActionControl actionRef={ref} onResult={onResult} className={action} />
        </li>
      ))}
      {model.links.map((l) => (
        <li key={l.id}>
          <LinkControl link={l} className={link} />
        </li>
      ))}
    </ul>
  );
}

export function WindowBar({ main }: { main: RefObject<HTMLElement | null> }) {
  const view = kit.useView();
  const pathname = kit.usePathname();
  const model = view.model;
  const [away, show] = useScrolledAway(main, model !== null);
  // Kept here, so a failure is still shown once the sheet that held the action has closed.
  const [error, setError] = useState<{ pathname: string; message: string } | null>(null);
  if (!model) return null;
  const tabs = tabsOf(view, model, pathname);
  const hasControls = model.actions.length + model.links.length > 0;
  const onResult = (message: string | null) => setError(message === null ? null : { pathname, message });
  const tabLinks = (className: string) =>
    tabs.map((tab) => (
      <li key={tab.href}>
        <kit.Link href={tab.href} current={tab.current} className={className}>
          {tab.title}
        </kit.Link>
      </li>
    ));
  return (
    <div
      data-window-bar=""
      onFocus={show}
      className={cx(
        "gt:sticky gt:top-0 gt:z-10 gt:-mx-4 gt:-mt-4 gt:mb-4 gt:border-b gt:border-border gt:bg-card gt:px-2 gt:transition-transform",
        "gt:medium:-mx-6 gt:medium:-mt-6 gt:medium:mb-6 gt:medium:px-6 gt:medium:pt-3",
        away && "gt:max-medium:-translate-y-full",
      )}
    >
      {/* Below 600 px: one bar. */}
      <div className="gt:flex gt:h-11 gt:min-w-0 gt:items-center gt:gap-1 gt:medium:hidden">
        {tabs.length > 0 ? (
          <Sheet
            title={model.title}
            trigger={
              <button type="button" aria-label={`${model.title}, tabs`} className={cx(BAR_BUTTON, "gt:min-w-0 gt:flex-1 gt:justify-start")}>
                <span className="gt:truncate gt:text-body gt:font-medium">{model.title}</span>
                <ChevronDown aria-hidden="true" focusable="false" className="gt:size-4 gt:shrink-0 gt:text-muted-foreground" />
              </button>
            }
          >
            <ul className="gt:flex gt:flex-col gt:gap-1">{tabLinks(SHEET_ROW)}</ul>
          </Sheet>
        ) : (
          <p className="gt:min-w-0 gt:flex-1 gt:truncate gt:px-2 gt:text-body gt:font-medium">{model.title}</p>
        )}
        {hasControls && (
          <Sheet
            title={`${model.title}: actions`}
            trigger={
              <button type="button" aria-label="Actions" className={cx(BAR_BUTTON, "gt:min-w-11")}>
                <Ellipsis aria-hidden="true" focusable="false" className="gt:size-5" />
              </button>
            }
          >
            <Controls model={model} onResult={onResult} inSheet />
          </Sheet>
        )}
      </div>
      {/* From 600 px: title and subtitle, controls, then tabs. */}
      <div className="gt:hidden gt:min-w-0 gt:items-start gt:gap-4 gt:pb-2 gt:medium:flex">
        <div className="gt:min-w-0 gt:flex-1">
          <p className="gt:truncate gt:text-title gt:font-semibold">{model.title}</p>
          {model.subtitle && <p className="gt:truncate gt:text-dense gt:text-muted-foreground">{model.subtitle}</p>}
        </div>
        {hasControls && <Controls model={model} onResult={onResult} inSheet={false} />}
      </div>
      {tabs.length > 0 && (
        <nav aria-label="Tabs" className="gt:hidden gt:medium:block">
          <ul className="gt:flex gt:gap-1 gt:overflow-x-auto">{tabLinks(TAB)}</ul>
        </nav>
      )}
      {error?.pathname === pathname && (
        <p role="status" className="gt:px-2 gt:pb-2 gt:text-caption gt:text-destructive-fg gt:medium:px-0">
          {error.message}
        </p>
      )}
    </div>
  );
}
