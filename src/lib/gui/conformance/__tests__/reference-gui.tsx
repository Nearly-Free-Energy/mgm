/**
 * The kit's own known-good GUI: a small Shell around kit.KitView. The
 * self-test runs every check against it, and the negative tests break one
 * thing at a time through `referenceGui(broken)`.
 */
import type { ReactNode } from "react";
import type { ActionRef, GuiMeta, GuiPlugin, NavEntry, OverlayProps, PublicPage, ShellProps, Signal } from "../../contract";
import { kit, Overlay } from "../../kit";

export const REFERENCE_META = {
  name: "reference",
  title: "Reference",
  version: "0.0.0",
  contract: "^0.1",
  styles: "./styles.css",
  dependencies: [],
} as const satisfies GuiMeta;

const TOUCH = "inline-flex items-center pointer-coarse:min-h-11";

/** One way to break the reference GUI per assertion, for the negative tests. */
export interface Broken {
  noMain?: boolean;
  twoMains?: boolean;
  noNav?: boolean;
  noStatus?: boolean;
  /** Leaves out the status items below 400 px only. */
  narrowNoStatus?: boolean;
  dropNav?: string;
  noChoices?: boolean;
  /** Renders nothing for an entry with no place to open. */
  noPlaceControl?: boolean;
  /** Draws the unknown-icon entry as an icon only, so its title is named but not shown. */
  hideUnknownTitle?: boolean;
  noOrgSwitch?: boolean;
  noSignOut?: boolean;
  unnamedButton?: boolean;
  positiveTabIndex?: boolean;
  tabWithHref?: boolean;
  noCurrent?: boolean;
  /** Draws a proposal signal as a plain button. */
  unmarkedProposal?: boolean;
  /** Adds a control that navigates to a path the host never handed out. */
  hardCodedHref?: boolean;
  /** Adds a control that opens a link the host never handed out. */
  openedHref?: boolean;
  /** An Overlay that leaves out the host's step. */
  overlayDropsStep?: boolean;
  /** A PublicFrame with no main landmark. */
  publicNoMain?: boolean;
  /** A PublicFrame that leaves out its children. */
  publicNoChildren?: boolean;
  /** A Loading that throws. */
  loadingThrows?: boolean;
  /** Leaves out the Needs-you count. */
  noCount?: boolean;
  /** Draws a your-move signal as text, with no link. */
  yourMoveText?: boolean;
  /** Adds a control named after a your-move signal that acts. */
  yourMoveActs?: boolean;
  /** Leaves out the proposal signals. */
  dropProposal?: boolean;
  /** Lists a proposal as a link to its page instead of acting on it. Not broken: check 5 accepts either. */
  proposalAsLink?: boolean;
  /** Lists a proposal as a link and also draws an unmarked control that acts on it. */
  proposalLinkAndUnmarked?: boolean;
  /** With signals, adds a control that acts on a ref no signal carries. */
  actsOffSignal?: boolean;
  /** With no signals, adds a control that acts on a ref the page never sent. */
  forgedAct?: boolean;
}

/** A ref no fixture carries. */
const FORGED: ActionRef = { action: "community.rename", params: { id: "forged" }, label: "Rename", enabled: true };

function SignalItem({ signal, broken }: { signal: Signal; broken: Broken }) {
  if (signal.kind === "your-move" && broken.yourMoveText) return <span>{signal.title}</span>;
  if (signal.kind === "your-move" && broken.yourMoveActs) {
    return (
      <>
        <kit.Link href={signal.href} className={TOUCH}>{signal.title}</kit.Link>
        <button type="button" className={TOUCH} onClick={() => void kit.act(FORGED)}>
          {signal.title} now
        </button>
      </>
    );
  }
  if (signal.kind !== "proposal" || broken.proposalAsLink) return <kit.Link href={signal.href} className={TOUCH}>{signal.title}</kit.Link>;
  const { action } = signal;
  if (broken.proposalLinkAndUnmarked) {
    return (
      <>
        <kit.Link href={signal.href} className={TOUCH}>{signal.title}</kit.Link>
        <button type="button" className={TOUCH} onClick={() => void kit.act(action)}>
          {action.label}
        </button>
      </>
    );
  }
  return (
    <button type="button" className={TOUCH} onClick={() => void kit.act(action)}>
      {broken.unmarkedProposal ? action.label : `Proposed: ${action.label}`}
    </button>
  );
}

function NavItem({ entry, broken }: { entry: NavEntry; broken: Broken }) {
  const view = kit.useView();
  const pathname = kit.usePathname();
  const href = view.href(entry);
  if (href) {
    const iconOnly = broken.hideUnknownTitle && entry.id === "acme.tickets";
    return (
      <kit.Link href={href} current={!broken.noCurrent && href === pathname} className={TOUCH}>
        {iconOnly ? <span role="img" aria-label={entry.title} /> : entry.title}
      </kit.Link>
    );
  }
  const kind = entry.needs.find((k) => !view.scope[k] && k !== "organization");
  const choices = kind ? view.choices(kind) : [];
  if (choices.length === 0 && broken.noPlaceControl) return null;
  return (
    <details>
      <summary className={TOUCH}>{entry.title}</summary>
      {choices.length === 0 && <p>No place to open yet.</p>}
      {!broken.noChoices &&
        choices.map((choice) => {
          const picked = view.href(entry, { [kind!]: choice });
          return picked && <kit.Link key={choice.id} href={picked} className={TOUCH}>{choice.label}</kit.Link>;
        })}
    </details>
  );
}

export function referenceGui(broken: Broken = {}): GuiPlugin {
  function Shell({ manifest, children }: ShellProps) {
    const pathname = kit.usePathname();
    const Main = broken.noMain ? "div" : "main";
    const Nav = broken.noNav ? "div" : "nav";
    const status = !broken.noStatus && !(broken.narrowNoStatus && window.innerWidth < 400);
    const current = (href: string) => !broken.noCurrent && href === pathname;
    const signals = kit.useSignals();
    return (
      <div>
        <Nav aria-label="Main">
          {manifest.org.nav
            .filter((entry) => entry.id !== broken.dropNav)
            .map((entry) => <NavItem key={entry.id} entry={entry} broken={broken} />)}
          {status && manifest.org.status.map((item) => <kit.Link key={item.id} href={item.open} current={current(item.open)} className={TOUCH}>{item.label}</kit.Link>)}
          {!broken.noOrgSwitch && manifest.orgs.map((org) => <kit.Link key={org.id} href={org.href} current={current(org.href)} className={TOUCH}>{org.name}</kit.Link>)}
        </Nav>
        {signals && !broken.noCount && <p>Needs you: {signals.count}</p>}
        {signals && signals.top.length > 0 && (
          <ul aria-label="Needs you">
            {signals.top.filter((s) => !(broken.dropProposal && s.kind === "proposal")).map((signal) => (
              <li key={signal.id}>
                <SignalItem signal={signal} broken={broken} />
              </li>
            ))}
          </ul>
        )}
        <Main tabIndex={broken.positiveTabIndex ? 1 : undefined}>{children}</Main>
        {broken.hardCodedHref && (
          <button type="button" className={TOUCH} onClick={() => kit.navigate("/reports")}>
            Reports
          </button>
        )}
        {broken.openedHref && (
          <button type="button" className={TOUCH} onClick={() => void kit.open({ id: "acme.reports", label: "Reports", href: "/reports" })}>
            Reports
          </button>
        )}
        {((broken.actsOffSignal && signals) || (broken.forgedAct && !signals)) && (
          <button type="button" className={TOUCH} onClick={() => void kit.act(FORGED)}>
            Rename everything
          </button>
        )}
        {broken.twoMains && <main>Again</main>}
        {broken.unnamedButton && <button type="button" className={TOUCH} />}
        {broken.tabWithHref && <a role="tab" href="#about" className={TOUCH}>About</a>}
        {!broken.noSignOut && <kit.SignOut className={TOUCH} />}
      </div>
    );
  }
  function DropsStep({ children, ...props }: OverlayProps) {
    void children;
    return <Overlay {...props}>{null}</Overlay>;
  }
  function PublicFrame({ children }: { page: PublicPage; children: ReactNode }) {
    const shown = broken.publicNoChildren ? null : children;
    return broken.publicNoMain ? <div>{shown}</div> : <main>{shown}</main>;
  }
  function Loading() {
    if (broken.loadingThrows) throw new Error("Loading failed");
    return <p role="status">Loading</p>;
  }
  return {
    ...REFERENCE_META,
    Shell,
    View: kit.KitView,
    Overlay: broken.overlayDropsStep ? DropsStep : Overlay,
    PublicFrame,
    Loading,
  };
}
