/**
 * A full page load of the code page, replacing the consent page in history
 * so Back does not return to a sign-in already answered. Its own module so
 * the consent page's tests can see where it goes: jsdom does not navigate.
 */
export function loadPage(url: string): void {
  window.location.replace(url);
}
