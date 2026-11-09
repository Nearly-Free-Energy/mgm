/**
 * Link targets for a microgrid's pages.
 *
 * Links point at the page a click finally lands on, never at a URL that only
 * redirects: each redirect costs the click one more request before the page
 * starts loading. The redirects themselves stay, for old bookmarks:
 *   - src/middleware.ts sends /microgrids/<id> to the Operations day view
 *     (microgridHref). If that target changes, change microgridHref with it;
 *     src/lib/__tests__/microgrid-links.test.ts fails until the two agree.
 *   - microgrids/[id]/setup/page.tsx sends /microgrids/<id>/setup to the
 *     Edges tab, and redirects through microgridSetupHref so the two cannot
 *     drift apart.
 */

/** Where a link to "this microgrid" lands: its Operations day view. */
export function microgridHref(microgridId: string): string {
  return `/microgrids/${microgridId}/operations`;
}

/** The first Setup tab, where a link to a microgrid's Setup area lands. */
export function microgridSetupHref(microgridId: string): string {
  return `/microgrids/${microgridId}/setup/edges`;
}
