"use client";

/**
 * Gridtop's drawing of `billing.savings@1`: the savings table, built from
 * the tiles, keyed `<column>.<row>`, and the ext's headings, warnings and
 * notes. Every string is the server's. The setup state is a note with its
 * link to Setup › Rates (left to the window bar on the page's own view); the
 * unavailable state draws nothing, since the day above already explains. The
 * host's notice and the model's controls are drawn here too, since the
 * window bar draws them only for the page's view.
 *
 * Loaded on demand by ./index.tsx, which hands it the kit. It imports no
 * module the shell's first load holds (types aside), not even the window
 * bar's controls: the bundler moves a module both share into a chunk of its
 * own, which costs the first load more than this chunk saves it.
 */
import { useId, useState } from "react";
import type { ModelOf, Value, ViewModel, ViewProps } from "@/lib/gui/contract";
import type { GuiKit } from "@/lib/gui/contract-react";

type Props = ViewProps & { kit: GuiKit };
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * The ext as the server's SavingsExt (src/lib/billing/surface/savings-ext.ts)
 * parses it. A change there is version 2, which this renderer does not read.
 */
type SavingsExt =
  | {
      state: "ready";
      synthetic: boolean;
      columns: { id: string; label: string; sub: string | null }[];
      rows: { id: string; label: string; sub: string | null; strong: boolean }[];
      warnings: string[];
      notes: string[];
    }
  | { state: "setup"; synthetic: boolean; title: string; text: string }
  | { state: "unavailable"; synthetic: boolean };

const SETUP_LINK = "billing.setup-rates";
const CONTROL =
  "gt:inline-flex gt:min-h-8 gt:items-center gt:rounded-md gt:border gt:border-border gt:bg-card gt:px-3 gt:text-dense gt:font-medium " +
  "gt:pointer-coarse:min-h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring gt:disabled:opacity-60";

function Cell({ value, strong }: { value: Value | undefined; strong: boolean }) {
  const empty = !value || value.t === "empty";
  return (
    <span className="gt:inline-flex gt:flex-wrap gt:items-baseline gt:justify-end gt:gap-x-1">
      <span className={cx(empty ? "gt:text-muted-foreground" : "gt:font-mono gt:tabular-nums", strong && !empty && "gt:font-semibold gt:text-foreground")}>
        {value?.text ?? "—"}
      </span>
      {value?.derived && <span className="gt:sr-only">estimated</span>}
      {value?.synthetic && <span className="gt:text-caption gt:font-semibold gt:uppercase gt:text-muted-foreground">Synthetic</span>}
    </span>
  );
}

/** The host's notice, such as the one on generated figures. */
function Notice({ model }: { model: ViewModel }) {
  if (!model.notice) return null;
  return <p className="gt:mb-3 gt:rounded-md gt:bg-warning-muted gt:px-3 gt:py-2 gt:text-dense gt:text-warning-fg">{model.notice.text}</p>;
}

/** The model's actions and other links, unless it is the page's own view, whose window bar draws them. */
function Footer({ model, kit }: { model: ViewModel; kit: GuiKit }) {
  const page = kit.useView().model;
  const [error, setError] = useState<string | null>(null);
  const rest = { ...model, links: model.links.filter((l) => l.id !== SETUP_LINK) };
  if (page?.view === model.view || rest.actions.length + rest.links.length === 0) return null;
  return (
    <div className="gt:mt-3 gt:flex gt:flex-col gt:gap-2">
      <ul className="gt:flex gt:flex-wrap gt:items-start gt:gap-2">
        {rest.actions.map((ref, i) => (
          <li key={`${ref.action}-${i}`} className="gt:flex gt:flex-col gt:gap-1">
            <button
              type="button"
              disabled={!ref.enabled}
              onClick={async () => {
                setError(null);
                const result = await kit.act(ref);
                if (!result.ok && result.code !== "cancelled") setError(result.message);
              }}
              className={cx(CONTROL, ref.tone === "danger" && "gt:border-destructive gt:text-destructive-fg", ref.provenance && "gt:border-dashed")}
            >
              {ref.provenance && "Proposed: "}
              {ref.label}
            </button>
            {!ref.enabled && ref.reason && <span className="gt:text-caption gt:text-muted-foreground">{ref.reason}</span>}
          </li>
        ))}
        {rest.links.map((link) => (
          <li key={link.id}>
            <a
              href={link.href}
              className={cx(CONTROL, "gt:text-primary")}
              onClick={(event) => {
                // A modified click is left to the browser, which opens a new tab or window.
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                void kit.open(link);
              }}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="gt:text-caption gt:text-destructive-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export default function SavingsView({ model, kit }: Props) {
  const headingId = useId();
  const page = kit.useView().model;
  const ext = model.ext?.data as SavingsExt | undefined;
  // Under the day, nothing of its own: the day above explains. On its own
  // page there is no day above, so say where the reason is: the Operations
  // day, attached to the microgrid as a tab (metering.site-day). If that
  // view stops being offered there, revisit. Another plugin's controls still show.
  if (!ext || ext.state === "unavailable") {
    return (
      <>
        <Notice model={model} />
        {page?.view === model.view && (
          <p className="gt:max-w-prose gt:text-body gt:text-muted-foreground">
            The savings cannot be worked out for this microgrid right now. The Operations day says why.
          </p>
        )}
        <Footer model={model} kit={kit} />
      </>
    );
  }
  if (ext.state === "setup") {
    // On the page's own view the window bar already offers the link.
    const link = page?.view === model.view ? undefined : model.links.find((l) => l.id === SETUP_LINK);
    return (
      <section className="gt:flex gt:flex-col gt:items-start gt:gap-2 gt:rounded-lg gt:border gt:border-dashed gt:border-border gt:bg-card gt:p-6">
        <Notice model={model} />
        <p className="gt:text-caption gt:font-medium gt:uppercase gt:text-muted-foreground">Savings</p>
        <h2 className="gt:text-title gt:font-semibold gt:text-foreground">{ext.title}</h2>
        <p className="gt:text-body gt:text-muted-foreground">{ext.text}</p>
        {link && link.href.startsWith("/") && (
          <kit.Link
            href={link.href as `/${string}`}
            className="gt:inline-flex gt:items-center gt:rounded-md gt:bg-primary gt:px-3 gt:py-2 gt:text-body gt:font-medium gt:text-primary-foreground gt:pointer-coarse:min-h-11"
          >
            {link.label}
          </kit.Link>
        )}
        <Footer model={model} kit={kit} />
      </section>
    );
  }
  const tiles = new Map((model as ModelOf<"metrics">).body.tiles.map((t) => [t.key, t.value]));
  return (
    <section aria-labelledby={headingId} className="gt:rounded-lg gt:border gt:border-border gt:bg-card gt:p-4 gt:medium:p-6">
      <Notice model={model} />
      <h2 id={headingId} className="gt:text-body gt:font-semibold gt:text-foreground">
        {model.title}
      </h2>
      <div className="gt:relative gt:mt-3 gt:overflow-x-auto">
        <table className="gt:w-full gt:text-left gt:text-dense">
          <thead>
            <tr className="gt:border-b gt:border-border">
              <th scope="col" className="gt:pb-2 gt:pr-4 gt:font-medium gt:text-muted-foreground">
                <span className="gt:sr-only">Figure</span>
              </th>
              {ext.columns.map((c) => (
                <th key={c.id} scope="col" className="gt:pb-2 gt:pl-4 gt:text-right gt:align-bottom gt:font-medium gt:text-muted-foreground">
                  <span className="gt:block">{c.label}</span>
                  {c.sub && <span className="gt:block gt:text-caption gt:font-normal">{c.sub}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ext.rows.map((r) => (
              <tr key={r.id} className={cx("gt:border-b gt:border-border gt:last:border-0", r.strong && "gt:bg-muted")}>
                <th scope="row" className={cx("gt:py-2 gt:pr-4 gt:text-left gt:align-top gt:font-normal gt:text-foreground", r.strong && "gt:font-semibold")}>
                  <span className="gt:block">{r.label}</span>
                  {r.sub && <span className="gt:block gt:text-caption gt:text-muted-foreground">{r.sub}</span>}
                </th>
                {ext.columns.map((c) => (
                  <td key={c.id} className="gt:py-2 gt:pl-4 gt:text-right gt:align-top">
                    <Cell value={tiles.get(`${c.id}.${r.id}`)} strong={r.strong} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ext.warnings.length > 0 && (
        <ul className="gt:mt-3 gt:flex gt:flex-col gt:gap-1 gt:text-caption gt:text-warning-fg">
          {ext.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="gt:mt-4 gt:flex gt:flex-col gt:gap-1 gt:text-caption gt:text-muted-foreground">
        {ext.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
      <Footer model={model} kit={kit} />
    </section>
  );
}
