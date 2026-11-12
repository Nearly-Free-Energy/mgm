/**
 * The account menu: who is signed in, their profile, the status items below
 * 600 px, and Sign out. A failed sign-out shows the kit's message here, and
 * the sheet stays open so the person can try again.
 */
import { UserRound } from "lucide-react";
import { kit } from "@/lib/gui/kit";
import { SHEET_ROW, Sheet } from "../ui/sheet";
import { StatusLinks, TRAY_BUTTON } from "./tray-parts";

/** The profile page's nav id (src/lib/organization-directory/surface.ts, which keeps it if the page moves to a view); if it changes, revisit. */
const PROFILE = "org.profile";

export function UserMenu() {
  const { user, org } = kit.useManifest();
  const view = kit.useView();
  const who = user.name ?? user.email;
  const profile = org.nav.find((entry) => entry.id === PROFILE);
  const profileHref = profile && view.href(profile);
  return (
    <Sheet
      title="Account"
      trigger={
        <button type="button" aria-label={`Account: ${who}`} className={TRAY_BUTTON}>
          <UserRound aria-hidden="true" focusable="false" className="gt:size-5" />
          <span className="gt:hidden gt:max-w-48 gt:truncate gt:expanded:inline">{who}</span>
        </button>
      }
    >
      <div className="gt:flex gt:flex-col gt:gap-2">
        <p className="gt:flex gt:flex-col gt:px-1">
          {user.name && <span className="gt:text-body gt:font-medium">{user.name}</span>}
          <span className="gt:text-dense gt:break-all gt:text-muted-foreground">{user.email}</span>
        </p>
        {profileHref && (
          <kit.Link href={profileHref} className={SHEET_ROW}>
            {profile.title}
          </kit.Link>
        )}
        <StatusLinks items={org.status} className="gt:flex gt:flex-col gt:gap-1 gt:medium:hidden" />
        <kit.SignOut className="gt:min-h-11 gt:rounded-md gt:border gt:border-border gt:px-3 gt:text-body gt:text-foreground gt:hover:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring" />
      </div>
    </Sheet>
  );
}
