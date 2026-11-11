/**
 * The 48 px band above the page: the mark, which opens the dashboard when
 * the manifest's nav has one, the organization switcher, the trail as plain links (only its last crumb
 * below 600 px), and the tray.
 */
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { OrgSwitcher } from "./org-switcher";
import { Tray } from "./tray";

const CRUMB =
  "gt:block gt:truncate gt:rounded-sm gt:px-1 gt:leading-8 gt:text-muted-foreground gt:hover:text-foreground " +
  "gt:pointer-coarse:leading-11 gt:aria-[current=page]:font-medium gt:aria-[current=page]:text-foreground " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

const MARK = "gt:inline-flex gt:size-9 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:text-title gt:text-primary gt:pointer-coarse:size-11";

/** The dashboard's nav id (src/lib/organization-directory/surface.ts, which keeps it if the page moves to a view); if it changes, revisit. */
const DASHBOARD = "org.today";

export function TitleBar() {
  const view = kit.useView();
  const { org } = kit.useManifest();
  const { trail, title } = view;
  const last = trail.length - 1;
  // A GUI links only where the host points (conformance check 6), so the mark follows the dashboard's nav entry.
  const today = org.nav.find((entry) => entry.id === DASHBOARD);
  const home = today && view.href(today);
  return (
    <header className="gt:col-span-full gt:flex gt:h-12 gt:min-w-0 gt:items-center gt:gap-2 gt:border-b gt:border-border gt:bg-card gt:px-2 gt:medium:px-3">
      {home ? (
        <kit.Link href={home} className={cx(MARK, "gt:hover:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring")}>
          <span aria-hidden="true">◆</span>
          <span className="gt:sr-only">{today.title}</span>
        </kit.Link>
      ) : (
        <span aria-hidden="true" className={MARK}>
          ◆
        </span>
      )}
      <OrgSwitcher />
      <nav aria-label="You are here" className="gt:min-w-0 gt:flex-1">
        {trail.length === 0 ? (
          <p className="gt:truncate gt:px-1 gt:text-dense gt:font-medium gt:text-foreground">{title}</p>
        ) : (
          <ol className="gt:flex gt:min-w-0 gt:items-center gt:gap-1 gt:text-dense">
            {trail.map((crumb, i) => (
              <li
                key={`${i}:${crumb.href}`}
                className={cx("gt:min-w-0 gt:items-center gt:gap-1", i === last ? "gt:flex" : "gt:hidden gt:medium:flex")}
              >
                {i > 0 && (
                  <span aria-hidden="true" className="gt:hidden gt:text-subtle-foreground gt:medium:inline">
                    ›
                  </span>
                )}
                <kit.Link href={crumb.href} current={i === last} className={CRUMB}>
                  {crumb.label}
                </kit.Link>
              </li>
            ))}
          </ol>
        )}
      </nav>
      <Tray />
    </header>
  );
}
