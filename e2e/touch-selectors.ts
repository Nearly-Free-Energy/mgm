// The selectors of the two 44 px rules in globals.css's coarse-pointer block:
// every control that gets a 44 px minimum height, and the ones that also get
// a 44 px minimum width. The smoke measures what these select.
// src/lib/__tests__/touch-targets.test.ts fails when they differ from the
// compiled stylesheet. No Playwright import, so that test can load this file.

export const TOUCH_TALL =
  ":where(" +
  [
    'button:not([role="radio"], [role="checkbox"])',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    'a[class~="flex"]',
    'a[class~="inline-flex"]',
    "summary",
    "select",
    "textarea",
    'input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="file"], [type="range"])',
    'label:has(input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"])',
  ].join(", ") +
  '):not(.sr-only, [aria-hidden="true"])';

export const TOUCH_WIDE =
  ':where(button:not([role="radio"], [role="checkbox"]), [role="button"]):not(.sr-only, [aria-hidden="true"])';
