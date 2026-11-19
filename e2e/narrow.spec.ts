import { expect, test, type Locator } from "@playwright/test";
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

test("a tenant record's app access renders at 360 px", async ({ page }) => {
  const { microgridId, accessEmail } = readSmokeFixtures();
  expect(accessEmail, "the fixtures give the first tenant app access").toBeTruthy();
  const watch = await watchPage(page);
  await page.goto(`/microgrids/${microgridId}/setup/tenants`);
  // The fixtures store no tenant id: take the record's address from the
  // row's menu, and load it on its own so its timing is its own.
  await page.getByRole("button", { name: "Actions for Smoke tenant 1 with a long display name" }).click();
  const recordPath = await page.getByRole("menuitem", { name: "View detail" }).getAttribute("href");
  expect(recordPath, "the row's menu links to the tenant record").toMatch(/\/setup\/tenants\/[0-9a-f-]+$/);
  await page.goto(recordPath!);
  await expect(page.getByRole("heading", { name: "App access", exact: true })).toBeVisible();
  // The tenant app is on for the smoke's organization and one long address
  // has access (fixtures.ts): the list, not the empty state.
  await expect(page.getByText(accessEmail!, { exact: true })).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Tenant record");

  // Give access: the dialog fits the screen. Nothing is submitted.
  await page.getByRole("button", { name: "Give access" }).click();
  const give = page.getByRole("dialog");
  await expect(give).toBeVisible();
  await checkDialogFits(give);
  await checkTouchTargets(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(give).toBeHidden();

  // Remove: the destructive confirmation, with the long address, fits the
  // screen and does not scroll sideways. Nothing is confirmed.
  await page.getByRole("button", { name: `Remove access for ${accessEmail}` }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(accessEmail!, { exact: true })).toBeVisible();
  await checkDialogFits(confirm);
  await checkTouchTargets(page, '[role="alertdialog"]');
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await checkNarrowPage(page);
  watch.assertClean();
});

/** The dialog is inside the 360 x 800 screen and its own content does not scroll sideways. */
async function checkDialogFits(dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  expect(
    await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
    "the dialog scrolls sideways"
  ).toBeLessThanOrEqual(0);
}
