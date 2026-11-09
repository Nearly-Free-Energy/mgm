import { expect, test } from "@playwright/test";
import { checkNarrowPage, checkTouchTargets, reportTiming, watchPage } from "./checks";
import { readSmokeFixtures } from "./fixtures";

// Signed in as the smoke's organization manager (auth.setup.ts), on a
// 360 px touch screen (playwright.config.ts).

test("home renders at 360 px", async ({ page }) => {
  const watch = watchPage(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Smoke microgrid 1" })).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Home");
  watch.assertClean();
});

test("the households page renders at 360 px", async ({ page }) => {
  const { microgridId } = readSmokeFixtures();
  const watch = watchPage(page);
  await page.goto(`/microgrids/${microgridId}/setup/households`);
  await expect(page.getByRole("heading", { name: "3 households" })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByText("Smoke household 1 with a long display name")).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Households");

  // The Add household dialog fits the screen. Nothing is submitted.
  await page.getByRole("button", { name: "+ Add household" }).click();
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
