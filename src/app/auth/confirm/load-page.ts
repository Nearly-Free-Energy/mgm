/**
 * A full page load of a same-site path, replacing the current entry in
 * history. Its own module so the confirm page's tests can see where it goes:
 * jsdom does not navigate, and its window.location cannot be stubbed.
 */
export function loadPage(path: string): void {
  window.location.replace(path);
}
