import { expect, test } from "@playwright/test";
import { checkNarrowPage, checkTouchTargets, reportTiming, watchPage } from "./checks";
import { readSmokeFixtures } from "./fixtures";

// Signed in as the smoke's organization manager (auth.setup.ts), on a
// 360 px touch screen (playwright.config.ts).

test("home renders at 360 px", async ({ page }) => {
  const watch = await watchPage(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Smoke microgrid 1" })).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Home");
  watch.assertClean();
});

test("the tenants page renders at 360 px", async ({ page }) => {
  const { microgridId } = readSmokeFixtures();
  const watch = await watchPage(page);
  await page.goto(`/microgrids/${microgridId}/setup/tenants`);
  await expect(page.getByRole("heading", { name: "3 tenants" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByText("Smoke tenant 1 with a long display name")).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Tenants");

  // The Add tenant dialog fits the screen. Nothing is submitted.
  await page.getByRole("button", { name: "+ Add tenant" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await checkTouchTargets(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  watch.assertClean();
});

test("a period's close checklist and its confirmation render at 360 px", async ({ page }) => {
  const { microgridId, periodId } = readSmokeFixtures();
  // Opening Close prepares the action, a POST that writes nothing
  // (src/lib/gui/host/server/prepare.ts); if prepare starts writing, take it
  // out of here. Nothing is confirmed: a POST to the close route is flagged.
  const watch = await watchPage(page, { expectedWrites: [/^\/api\/gui\/prepare$/] });
  await page.goto(`/microgrids/${microgridId}/billing/${periodId}/close`);
  await expect(page.getByRole("heading", { name: "Close October 2026" })).toBeVisible();
  for (const step of ["Bills for every tenant", "Usage on every bill", "Totals to file", "Close the period"]) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }
  await checkNarrowPage(page);
  await reportTiming(page, "Close checklist");

  // The host's confirmation step: the totals, a box for each
  // acknowledgement and the name to type, inside the screen.
  await page.getByRole("button", { name: "Close period" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Type October 2026 to confirm")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  await expect(dialog.getByRole("textbox")).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await checkTouchTargets(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  watch.assertClean();
});
