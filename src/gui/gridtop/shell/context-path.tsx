/**
 * The context path in the title bar: organization › community › microgrid ›
 * app, from the view's trail. A crumb that names a place has a ▾ that opens
 * a switcher, when there is another place of its kind to go to. Below 600 px
 * only the last crumb shows, and its ▾ opens a sheet with the whole path and
 * every switcher.
 */
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import type { Href, Id } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { SHEET_ROW, Sheet } from "../ui/sheet";
import { crumbsOf, switcherFor, type Crumb, type Switcher } from "./switch";

const CRUMB =
  "gt:block gt:truncate gt:rounded-sm gt:px-1 gt:leading-8 gt:text-muted-foreground gt:hover:text-foreground " +
  "gt:pointer-coarse:leading-11 gt:aria-[current=page]:font-medium gt:aria-[current=page]:text-foreground " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

/** No display utility here: each caret sets its own, since two on one element resolve by stylesheet order, not class order. */
const CARET =
  "gt:size-8 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:text-muted-foreground " +
  "gt:hover:bg-muted gt:hover:text-foreground gt:aria-expanded:bg-muted gt:pointer-coarse:size-11 " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

/** Each crumb in the whole-path sheet sits one step further in than the one before. */
const DEPTH = ["gt:ps-3", "gt:ps-6", "gt:ps-9", "gt:ps-12"];

const samePage = (href: Href, pathname: string) => href.split(/[?#]/, 1)[0] === pathname;

/** A sheet's trigger: it passes on the props and ref the sheet gives it. */
function Caret({ label, className, ...rest }: ComponentProps<"button"> & { label: string }) {
  return (
    <button type="button" {...rest} aria-label={label} className={cx(CARET, className)}>
      <ChevronDown aria-hidden="true" focusable="false" className="gt:size-4" />
    </button>
  );
}

/** A switcher's places, grouped, the current one marked with a check. */
function Choices({ switcher }: { switcher: Switcher }) {
  const pathname = kit.usePathname();
  return (
    <div className="gt:flex gt:flex-col gt:gap-3">
      {switcher.groups.map((group) => (
        <div key={group.title} className="gt:flex gt:flex-col gt:gap-1">
          <p className="gt:px-1 gt:text-caption gt:text-muted-foreground">{group.title}</p>
          <ul aria-label={group.title} className="gt:flex gt:flex-col gt:gap-1">
            {group.choices.map((choice) => {
              const content = (
                <>
                  <span className="gt:min-w-0 gt:flex-1 gt:truncate">{choice.label}</span>
                  {choice.detail && <span className="gt:shrink-0 gt:text-caption gt:text-muted-foreground">{choice.detail}</span>}
                  {choice.current && <Check aria-hidden="true" focusable="false" className="gt:size-4 gt:shrink-0 gt:text-primary" />}
                </>
              );
              return (
                <li key={choice.id} aria-current={choice.current || undefined}>
                  {choice.href ? (
                    <kit.Link href={choice.href} current={samePage(choice.href, pathname)} className={SHEET_ROW}>
                      {content}
                    </kit.Link>
                  ) : (
                    <span className={cx(SHEET_ROW, "gt:text-muted-foreground")}>{content}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The whole path and every switcher, for windows under 600 px. */
function WholePath(props: { crumbs: Crumb[]; switchers: (Switcher | null)[]; last: number; title: string | null }) {
  const { crumbs, switchers, last, title } = props;
  const pathname = kit.usePathname();
  return (
    <Sheet title="Where you are" trigger={<Caret label="Show the whole path" className="gt:inline-flex gt:medium:hidden" />}>
      <div className="gt:flex gt:flex-col gt:gap-4">
        <ol className="gt:flex gt:flex-col gt:gap-1">
          {crumbs.map((crumb, i) => (
            <li key={`${i}:${crumb.href}`}>
              <kit.Link
                href={crumb.href}
                current={i === last || samePage(crumb.href, pathname)}
                className={cx(SHEET_ROW, DEPTH[Math.min(i, DEPTH.length - 1)])}
              >
                {crumb.label}
              </kit.Link>
            </li>
          ))}
          {title !== null && (
            <li className={cx(SHEET_ROW, "gt:font-medium", DEPTH[Math.min(crumbs.length, DEPTH.length - 1)])}>{title}</li>
          )}
        </ol>
        {switchers.map(
          (switcher) =>
            switcher && (
              <section key={switcher.kind} aria-label={switcher.title} className="gt:flex gt:flex-col gt:gap-1">
                <h3 className="gt:px-1 gt:text-body gt:font-medium">{switcher.title}</h3>
                <Choices switcher={switcher} />
              </section>
            ),
        )}
      </div>
    </Sheet>
  );
}

export function ContextPath({ app }: { app: Id | null }) {
  const view = kit.useView();
  const manifest = kit.useManifest();
  const pathname = kit.usePathname();
  const crumbs = crumbsOf(view, manifest);
  if (crumbs.length === 0) {
    return (
      <nav aria-label="You are here" className="gt:min-w-0 gt:flex-1">
        <p className="gt:truncate gt:px-1 gt:text-dense gt:font-medium gt:text-foreground">{view.title}</p>
      </nav>
    );
  }
  const switchers = crumbs.map((crumb) => (crumb.kind ? switcherFor(crumb.kind, view, manifest, app) : null));
  // With no trail, the title follows the organization crumb as the page itself.
  const title = view.trail.length === 0 ? view.title : null;
  const last = title === null ? crumbs.length - 1 : -1;
  const more = crumbs.length > 1 || title !== null || switchers.some(Boolean);
  const whole = more && <WholePath crumbs={crumbs} switchers={switchers} last={last} title={title} />;
  const separator = (
    <span aria-hidden="true" className="gt:hidden gt:text-subtle-foreground gt:medium:inline">
      ›
    </span>
  );
  return (
    <nav aria-label="You are here" className="gt:min-w-0 gt:flex-1">
      <ol className="gt:flex gt:min-w-0 gt:items-center gt:gap-1 gt:text-dense">
        {crumbs.map((crumb, i) => {
          const switcher = switchers[i];
          return (
            <li
              key={`${i}:${crumb.href}`}
              className={cx("gt:min-w-0 gt:items-center gt:gap-0.5", i === last ? "gt:flex" : "gt:hidden gt:medium:flex")}
            >
              {i > 0 && separator}
              <kit.Link href={crumb.href} current={i === last || samePage(crumb.href, pathname)} className={CRUMB}>
                {crumb.label}
              </kit.Link>
              {switcher && (
                <Sheet title={switcher.title} trigger={<Caret label={`Switch ${switcher.kind}`} className="gt:hidden gt:medium:inline-flex" />}>
                  <Choices switcher={switcher} />
                </Sheet>
              )}
              {i === last && whole}
            </li>
          );
        })}
        {title !== null && (
          <li className="gt:flex gt:min-w-0 gt:items-center gt:gap-0.5">
            {separator}
            <span className="gt:truncate gt:px-1 gt:font-medium gt:text-foreground">{title}</span>
            {whole}
          </li>
        )}
      </ol>
    </nav>
  );
}
