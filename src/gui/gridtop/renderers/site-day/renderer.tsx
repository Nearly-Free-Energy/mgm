"use client";

/**
 * Gridtop's renderer for `metering.site-day@1`, the Operations day, loaded
 * on its own by ./index.tsx: the day picker, the six tiles, the battery
 * chart, the evening strip, the notes, and the view's actions and links,
 * which the window bar leaves to it (../../shell/window-bar.tsx). It prints
 * the text the server formatted and writes only through kit.act. A model
 * whose ext it cannot read is drawn by the kit's view instead.
 *
 * The kit comes from ./index.tsx as a prop, and these files import nothing
 * else of Gridtop's or the kit's, so this chunk shares no module with the
 * shell's. A shared one makes the bundler split the shell's chunks again,
 * which cost about 650 first-load bytes when measured; if a shared import is
 * added, measure the budgets again.
 */
import { useId, useState } from "react";
import type { ActionRef, GuiKit, Href, LinkRef, ModelOf, SyncNode, Tone, ViewModel, ViewProps } from "@/lib/gui/contract";
import { BatteryChart } from "./battery-chart";
import { DAY_LINKS, DayPicker } from "./day-picker";
import { EveningStrip } from "./evening-strip";
import { readSiteDayExt, type SiteDayExt, cls } from "./ext";
import { Tiles } from "./tiles";

// The window bar's control style (../../shell/window-bar.tsx), at least 44 px high on a touch screen.
const CONTROL =
  "gt:inline-flex gt:h-8 gt:items-center gt:gap-2 gt:rounded-md gt:border gt:px-3 gt:text-dense gt:font-medium " +
  "gt:pointer-coarse:h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:disabled:cursor-not-allowed gt:disabled:opacity-60";

const EDGES_LINK = "metering.edges";
// The battery series and the evening tile, as site-day-model.ts (src/lib/metering/surface) keys them; if it renames them, revisit.
const SOC = "soc";
const EVENING_SUPPLY = "evening-supply";
const SYNTHETIC_BAND = "Synthetic data: generated for demonstration, not measured";

const BAND: Record<Tone, string> = {
  neutral: "gt:bg-muted gt:text-foreground",
  info: "gt:bg-muted gt:text-foreground",
  accent: "gt:bg-accent gt:text-accent-foreground",
  success: "gt:bg-success-muted gt:text-success-fg",
  warning: "gt:bg-warning-muted gt:text-warning-fg",
  danger: "gt:bg-destructive-muted gt:text-destructive-fg",
};

function Band({ tone, text }: { tone: Tone; text: string }) {
  return <p className={cls("gt:rounded-md gt:px-3 gt:py-2 gt:text-dense gt:font-medium", BAND[tone] ?? BAND.neutral)}>{text}</p>;
}

/**
 * The model's notice, and the synthetic band unless the notice already says
 * so. The host puts SYNTHETIC_NOTICE (src/lib/gui/host/server/view.ts) on a
 * synthetic model unless the gate's notice is shown, and its text says
 * "synthetic"; if that wording changes, revisit this check, or the band is
 * drawn under it as well.
 */
function Notices({ model, ext }: { model: ViewModel; ext: SiteDayExt }) {
  const notice = model.notice;
  const said = notice !== undefined && /synthetic/i.test(notice.text);
  return (
    <>
      {notice && <Band tone={notice.tone} text={notice.text} />}
      {ext.synthetic && !said && <Band tone="warning" text={SYNTHETIC_BAND} />}
    </>
  );
}

/** Writes only through kit.act, with the ref as the model gave it; a disabled action says why instead. */
function ActionControl({ actionRef, onResult, kit }: { actionRef: ActionRef; onResult(message: string | null): void; kit: GuiKit }) {
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
        className={cls(
          CONTROL,
          actionRef.tone === "danger" ? "gt:border-destructive gt:bg-destructive-muted gt:text-destructive-fg" : "gt:border-border gt:bg-card gt:text-foreground gt:hover:bg-muted",
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

/**
 * A page link through kit.Link, which draws a span for an href the host's
 * check refuses; a download, a share or an outside target is a button that
 * opens it through kit.open, so no anchor skips that call.
 */
function LinkControl({ link, className, kit }: { link: LinkRef; className: string; kit: GuiKit }) {
  if (link.download || link.share || !link.href.startsWith("/")) {
    return (
      <button type="button" className={className} onClick={() => void kit.open(link)}>
        {link.label}
      </button>
    );
  }
  return (
    <kit.Link href={link.href as Href} className={className}>
      {link.label}
    </kit.Link>
  );
}

/** The legacy page's empty state: what to register, and the link to where it is done. */
function NoSiteDevices(props: { ext: Extract<SiteDayExt, { state: "no-site-devices" }>; edges: LinkRef | undefined; kit: GuiKit }) {
  const { ext, edges, kit } = props;
  return (
    <section className="gt:flex gt:flex-col gt:items-center gt:gap-3 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:px-6 gt:py-10 gt:text-center">
      <h3 className="gt:text-title gt:font-semibold gt:text-foreground">{ext.title}</h3>
      <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">{ext.message}</p>
      {edges && <LinkControl kit={kit} link={edges} className={cls(CONTROL, "gt:border-primary gt:bg-primary gt:text-primary-foreground")} />}
    </section>
  );
}

/** Every action, and each link the picker and the empty state did not place. */
function Controls({ model, placed, kit }: { model: ViewModel; placed: Set<string>; kit: GuiKit }) {
  const [error, setError] = useState<string | null>(null);
  const links = model.links.filter((l) => !placed.has(l.id));
  if (model.actions.length + links.length === 0) return null;
  return (
    <section aria-label="Actions and links" className="gt:flex gt:flex-col gt:gap-2">
      <ul className="gt:flex gt:flex-wrap gt:items-start gt:gap-2">
        {model.actions.map((ref, i) => (
          <li key={`${ref.action}-${i}`}>
            <ActionControl kit={kit} actionRef={ref} onResult={setError} />
          </li>
        ))}
        {links.map((l) => (
          <li key={l.id}>
            <LinkControl kit={kit} link={l} className={cls(CONTROL, "gt:border-transparent gt:text-primary gt:hover:underline")} />
          </li>
        ))}
      </ul>
      {error && (
        <p role="status" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </section>
  );
}

function SiteDay({ model, ext, kit }: { model: ModelOf<"metrics">; ext: SiteDayExt; kit: GuiKit }) {
  const edges = ext.state === "no-site-devices" ? model.links.find((l) => l.id === EDGES_LINK) : undefined;
  const placed = new Set([...DAY_LINKS, ...(edges ? [EDGES_LINK] : [])]);
  // The window bar shows the subtitle; the heading is the day without its
  // zone. site-day-model.ts (src/lib/metering/surface) builds the subtitle as
  // "<day> · <timezone>"; if that format changes, revisit.
  const zone = ` · ${ext.timezone}`;
  const heading = model.subtitle?.endsWith(zone) ? model.subtitle.slice(0, -zone.length) : (model.subtitle ?? ext.date);
  // Views attached as tabs are among the window bar's tabs.
  const attached = model.attached.filter((a) => a.hint !== "tab");
  return (
    <article data-gui-view={model.view} className="gt:flex gt:flex-col gt:gap-4">
      <h1 className="gt:sr-only">{model.title}</h1>
      <Notices model={model} ext={ext} />
      <DayPicker ext={ext} links={model.links} heading={heading} kit={kit} />
      {ext.state === "day" ? (
        <>
          <Tiles tiles={model.body.tiles} />
          <BatteryChart chart={ext} points={model.body.series?.find((s) => s.key === SOC)?.points ?? []} />
          <EveningStrip chart={ext} tile={model.body.tiles.find((t) => t.key === EVENING_SUPPLY)} />
          {ext.notes.map((note, i) => (
            <p key={i} className="gt:text-caption gt:text-muted-foreground">
              {note}
            </p>
          ))}
        </>
      ) : (
        <NoSiteDevices ext={ext} edges={edges} kit={kit} />
      )}
      <Controls model={model} placed={placed} kit={kit} />
      {attached.length > 0 && (
        <nav aria-label="Related views">
          <ul className="gt:flex gt:flex-wrap gt:gap-3 gt:text-dense">
            {attached.map((a) => (
              <li key={a.view}>
                <kit.Link href={a.href} className="gt:inline-flex gt:items-center gt:text-primary gt:hover:underline gt:pointer-coarse:min-h-11">
                  {a.title}
                </kit.Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

export function SiteDayView({ model, kit }: ViewProps & { kit: GuiKit }): SyncNode {
  const ext = model.kind === "metrics" ? readSiteDayExt(model.ext) : null;
  if (model.kind !== "metrics" || !ext) return <kit.KitView model={model} />;
  return <SiteDay model={model} ext={ext} kit={kit} />;
}
