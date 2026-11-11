/**
 * The organization switcher in the title bar, shown when the person has more
 * than one: a sheet with a link to each. The current one is marked as the
 * current item of the list, with a check; its link is the current page only
 * while that organization's page is shown.
 */
import { Building2, Check, ChevronDown } from "lucide-react";
import { kit } from "@/lib/gui/kit";
import { SHEET_ROW, Sheet } from "../ui/sheet";
import { TRAY_BUTTON } from "./tray-parts";

export function OrgSwitcher() {
  const { org, orgs } = kit.useManifest();
  const pathname = kit.usePathname();
  if (orgs.length < 2) return null;
  return (
    <Sheet
      title="Organizations"
      trigger={
        <button type="button" aria-label={`Organization: ${org.name}`} className={TRAY_BUTTON}>
          <Building2 aria-hidden="true" focusable="false" className="gt:size-5 gt:shrink-0" />
          <span className="gt:hidden gt:max-w-40 gt:truncate gt:medium:inline">{org.name}</span>
          <ChevronDown aria-hidden="true" focusable="false" className="gt:size-4 gt:shrink-0 gt:text-muted-foreground" />
        </button>
      }
    >
      <ul className="gt:flex gt:flex-col gt:gap-1">
        {orgs.map((o) => (
          <li key={o.id} aria-current={o.id === org.id || undefined}>
            <kit.Link href={o.href} current={o.href === pathname} className={SHEET_ROW}>
              <span className="gt:min-w-0 gt:flex-1 gt:truncate">{o.name}</span>
              {o.id === org.id && <Check aria-hidden="true" focusable="false" className="gt:size-4 gt:shrink-0 gt:text-primary" />}
            </kit.Link>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
