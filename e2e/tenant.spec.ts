import { expect, test, type Page } from "@playwright/test";
import { checkMainTargets, checkNarrowPage, reportTiming, watchPage } from "./checks";

// Signed in as the smoke's tenant (tenant.setup.ts), on a 360 px touch
// screen (playwright.config.ts), whose unit has one synthetic meter in
// Kampala, linked since the first of the month two months back
// (e2e/fixtures.ts). The views write nothing, so no write is expected, and
// Try again is never pressed. Figures are synthetic and depend on the date,
// so no kWh value is asserted.

/**
 * The month before the current UTC month, as YYYY-MM, and its number of
 * days. It is wholly past in Kampala (UTC+3) and inside the meter's link.
 */
function previousMonth(): { month: string; days: number } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return { month: start.toISOString().slice(0, 7), days };
}

const monthPath = (month: string) => `/my/usage?month=${month}`;
const dayPath = (date: string) => `/my/usage/day?date=${date}`;

/** Waits for the client to reach `target`, a path with its query. */
async function waitForPath(page: Page, target: string) {
  const want = new URL(target, "http://smoke.test");
  await page.waitForURL(
    (url) => url.pathname === want.pathname && url.search === want.search,
    { waitUntil: "commit" }
  );
}

test("the usage month renders at 360 px", async ({ page }) => {
  const { month, days } = previousMonth();
  const watch = await watchPage(page);
  await page.goto(monthPath(month));
  const main = page.getByRole("main");
  const table = main.getByRole("table", { name: /^Use per day, / });
  await expect(table).toBeVisible();
  // Every day of a past month links to its day.
  await expect(table.getByRole("link")).toHaveCount(days);
  await expect(main.getByText("Total", { exact: true }).first()).toBeVisible();
  await expect(main.getByText(/^Synthetic data:/)).toBeVisible();
  await checkNarrowPage(page);
  await checkMainTargets(page);
  await reportTiming(page, "Usage month");

  // The tenant's dock: their two apps, then the account menu.
  const dock = page.getByRole("navigation", { name: "Apps" });
  await expect(dock.getByRole("link", { name: "My home" })).toBeVisible();
  await expect(dock.getByRole("link", { name: "My usage" })).toBeVisible();
  await expect(dock.getByRole("button", { name: /^Account/ })).toBeVisible();
  watch.assertClean();
});

test("the usage day renders at 360 px", async ({ page }) => {
  const { month } = previousMonth();
  const watch = await watchPage(page);
  // A full load, so reportTiming measures this page and not a month's.
  await page.goto(dayPath(`${month}-15`));
  const main = page.getByRole("main");
  const table = main.getByRole("table", { name: /^Use per hour, / });
  await expect(table).toBeVisible();
  // Kampala keeps one offset all year, so every day has 24 hours.
  await expect(table.locator("tbody tr")).toHaveCount(24);
  // The bars repeat the table's figures and are hidden from assistive
  // technology, so they are found by element.
  await expect(main.locator("figure svg")).toHaveCount(1);
  await checkNarrowPage(page);
  await checkMainTargets(page);
  await reportTiming(page, "Usage day");
  watch.assertClean();
});

test("a tenant moves between the month and its days", async ({ page }) => {
  const { month } = previousMonth();
  const watch = await watchPage(page);
  await page.goto(monthPath(month));
  const main = page.getByRole("main");

  await main.locator(`a[href="${dayPath(`${month}-15`)}"]`).click();
  await waitForPath(page, dayPath(`${month}-15`));
  await expect(main.getByRole("table", { name: /^Use per hour, / })).toBeVisible();

  // The previous day's step. The 14th's own previous step shows that its
  // page, not the 15th's, is drawn.
  await main.locator(`a[href="${dayPath(`${month}-14`)}"]`).click();
  await waitForPath(page, dayPath(`${month}-14`));
  await expect(main.locator(`a[href="${dayPath(`${month}-13`)}"]`)).toBeVisible();

  // Up to the day's month.
  await main.locator(`a[href="${monthPath(month)}"]`).click();
  await waitForPath(page, monthPath(month));
  await expect(main.getByRole("table", { name: /^Use per day, / })).toBeVisible();
  watch.assertClean();
});
