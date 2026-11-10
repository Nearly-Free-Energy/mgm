/**
 * The 48 px band above the page: the mark, which opens the dashboard, the
 * trail as plain links (only its last crumb below 600 px), and the person's
 * name with Sign out. When sign-out fails, the kit's message opens below the
 * band rather than beside the button, so it can wrap on a narrow screen.
 */
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";

// The `alert` variant (../styles.css) reaches the kit's message only while it has text.
const SIGN_OUT_MESSAGE =
  "gt:alert:absolute gt:alert:top-full gt:alert:right-0 gt:alert:z-20 gt:alert:mt-1 gt:alert:w-64 " +
  "gt:alert:rounded-md gt:alert:border gt:alert:border-border gt:alert:bg-card gt:alert:p-2";

const CRUMB =
  "gt:block gt:truncate gt:rounded-sm gt:px-1 gt:leading-8 gt:text-muted-foreground gt:hover:text-foreground " +
  "gt:pointer-coarse:leading-11 gt:aria-[current=page]:font-medium gt:aria-[current=page]:text-foreground " +
  "gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

export function TitleBar() {
  const { user } = kit.useManifest();
  const { trail, title } = kit.useView();
  const last = trail.length - 1;
  return (
    <header className="gt:col-span-full gt:flex gt:h-12 gt:min-w-0 gt:items-center gt:gap-2 gt:border-b gt:border-border gt:bg-card gt:px-2 gt:medium:px-3">
      <kit.Link
        href="/"
        className="gt:inline-flex gt:size-9 gt:shrink-0 gt:items-center gt:justify-center gt:rounded-md gt:text-title gt:text-primary gt:hover:bg-muted gt:pointer-coarse:size-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring"
      >
        <span aria-hidden="true">◆</span>
        <span className="gt:sr-only">Dashboard</span>
      </kit.Link>
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
      <div className={cx("gt:relative gt:flex gt:shrink-0 gt:items-center gt:gap-2", SIGN_OUT_MESSAGE)}>
        <span className="gt:hidden gt:max-w-48 gt:truncate gt:text-caption gt:text-muted-foreground gt:expanded:inline">
          {user.name ?? user.email}
        </span>
        <kit.SignOut className="gt:h-9 gt:pointer-coarse:h-11 gt:rounded-md gt:border gt:border-border gt:px-3 gt:text-dense gt:text-foreground gt:hover:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring" />
      </div>
    </header>
  );
}
