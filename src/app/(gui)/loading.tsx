// Dashboard loading fallback.
//
// Sits inside (gui)/layout.tsx, so the sidebar and top bar stay on
// screen and only the main area shows this frame while a different section
// loads (/, /organizations, /communities, /microgrids, /settings). It also
// lets a full page load paint the chrome before the page's own queries
// finish.
//
// The layout's auth and first-run redirects run outside this boundary, so
// they stay real HTTP redirects. Keep them there: a redirect() or notFound()
// below this boundary runs after the frame has been sent, so on a full page
// load it arrives as a client-side redirect or not-found page with HTTP 200.
// That includes the access checks in the microgrid and community layouts
// and the organization pages: a user who cannot see the record gets the
// not-found page, which Next.js marks noindex, but not a 404 status. This is
// the price of the immediate frame. A check that needs a real 404 must run
// before every loading.tsx above it, that is in middleware.

import { SectionLoading } from "@/components/ui/section-loading";

export default function DashboardLoading() {
  return <SectionLoading label="page" />;
}
