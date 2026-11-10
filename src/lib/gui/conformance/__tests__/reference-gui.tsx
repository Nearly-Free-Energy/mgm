/**
 * The kit's own known-good GUI: a small Shell around kit.KitView. The
 * self-test runs every check against it, and the negative tests break one
 * thing at a time through `referenceGui(broken)`.
 */
import type { GuiMeta, GuiPlugin, NavEntry, ShellProps } from "../../contract";
import { kit } from "../../kit";

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
    return (
      <div>
        <Nav aria-label="Main">
          {manifest.org.nav
            .filter((entry) => entry.id !== broken.dropNav)
            .map((entry) => <NavItem key={entry.id} entry={entry} broken={broken} />)}
          {status && manifest.org.status.map((item) => <kit.Link key={item.id} href={item.open} current={current(item.open)} className={TOUCH}>{item.label}</kit.Link>)}
          {!broken.noOrgSwitch && manifest.orgs.map((org) => <kit.Link key={org.id} href={org.href} current={current(org.href)} className={TOUCH}>{org.name}</kit.Link>)}
        </Nav>
        <Main tabIndex={broken.positiveTabIndex ? 1 : undefined}>{children}</Main>
        {broken.twoMains && <main>Again</main>}
        {broken.unnamedButton && <button type="button" className={TOUCH} />}
        {broken.tabWithHref && <a role="tab" href="#about" className={TOUCH}>About</a>}
        {!broken.noSignOut && <kit.SignOut className={TOUCH} />}
      </div>
    );
  }
  return { ...REFERENCE_META, Shell, View: kit.KitView };
}
