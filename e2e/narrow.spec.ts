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

test("a microgrid's billing periods render at 360 px", async ({ page }) => {
  const { microgridId, periodId } = readSmokeFixtures();
  // Opening New billing period prepares the action, a POST that writes
  // nothing (src/lib/gui/host/server/prepare.ts); if prepare starts writing,
  // take it out of here. Nothing is submitted and no period is deleted.
  const watch = await watchPage(page, { expectedWrites: [/^\/api\/gui\/prepare$/] });
  await page.goto(`/microgrids/${microgridId}/billing`);
  // The host's catch-all serves the path: the legacy list had no view marker.
  await expect(page.locator('[data-gui-view="billing.periods"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Billing periods" })).toBeVisible();
  await expect(page.locator(`a[href="/microgrids/${microgridId}/billing/${periodId}"]`).first()).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await checkNarrowPage(page);
  await reportTiming(page, "Billing periods");

  // The create form fits the screen. Escape leaves it unsent.
  await page.getByRole("button", { name: "New billing period" }).click();
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await checkTouchTargets(page, '[role="dialog"], [role="alertdialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  watch.assertClean();
});

test("a period's history renders at 360 px", async ({ page }) => {
  const { microgridId, periodId } = readSmokeFixtures();
  const watch = await watchPage(page);
  await page.goto(`/microgrids/${microgridId}/billing/${periodId}/history`);
  await expect(page.locator('[data-gui-view="billing.period-history"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit history" })).toBeVisible();
  // The fixtures write no audit entry of their own, so this checks the
  // frame and its way back, not the entries.
  await checkNarrowPage(page);
  await reportTiming(page, "Period history");

  // Below 600 px Gridtop's window bar keeps a view's links in its Actions
  // sheet (src/gui/gridtop/shell/window-bar.tsx); if the bar ever shows them
  // itself, look for the link on the page instead. Opening it writes nothing.
  await page.getByRole("button", { name: "Actions" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(`a[href="/microgrids/${microgridId}/billing/${periodId}"]`)).toBeVisible();
  await checkTouchTargets(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
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
  // A confirm-level step is an alertdialog (the kit's Overlay,
  // src/lib/gui/kit/overlay.tsx); if the host frames it otherwise, follow it.
  await page.getByRole("button", { name: "Close period" }).click();
  const dialog = page.getByRole("alertdialog");
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
  await checkTouchTargets(page, '[role="alertdialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  watch.assertClean();
});

test("a period's send queue renders at 360 px", async ({ page }) => {
  const { microgridId, periodId } = readSmokeFixtures();
  // Loading the queue writes nothing and calls no provider; no link is
  // opened or copied here (copying is covered by the renderer's unit test).
  const watch = await watchPage(page);
  await page.goto(`/microgrids/${microgridId}/billing/${periodId}/send`);
  await expect(page.getByRole("heading", { name: "October 2026 payment links" })).toBeVisible();
  await expect(page.getByText("Nothing is sent from this page. Copy each bill's link and share it with its tenant yourself.")).toBeVisible();
  for (const n of [1, 2]) await expect(page.getByText(`Smoke tenant ${n} with a long display name`, { exact: true })).toBeVisible();
  await expect(page.getByText("Payment links use a sandbox account: payments made through them are tests.")).toBeVisible();
  // The bill with usage has a link to copy; the zero bill has nothing to collect.
  await expect(page.getByRole("button", { name: "Copy payment link for Smoke tenant 1 with a long display name" })).toBeVisible();
  await expect(page.getByText("Nothing to collect.")).toBeVisible();
  await checkNarrowPage(page);
  await checkTouchTargets(page, "[data-send-queue]");
  await reportTiming(page, "Send queue");
  watch.assertClean();
});

test("a bill's payments render at 360 px", async ({ page }) => {
  const { microgridId, periodId, billId } = readSmokeFixtures();
  // Opening Record completed adjustment prepares the action, a POST that
  // writes nothing (src/lib/gui/host/server/prepare.ts); if prepare starts
  // writing, take it out of here. Nothing is submitted, and Refresh status is
  // never pressed: it asks the payment provider.
  const watch = await watchPage(page, { expectedWrites: [/^\/api\/gui\/prepare$/] });
  await page.goto(`/microgrids/${microgridId}/billing/${periodId}/payments?bill=${billId}`);
  await expect(page.getByRole("heading", { name: "Payments: Smoke tenant 1 with a long display name" })).toBeVisible();
  await expect(page.getByText("Needs reconciliation", { exact: true })).toBeVisible();
  for (const name of ["Refresh status", "Record completed adjustment", "Accept exact receipts"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  await checkNarrowPage(page);
  await reportTiming(page, "Bill payments");

  // The typed step fits the screen. Escape leaves it unsent.
  await page.getByRole("button", { name: "Record completed adjustment" }).click();
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "the dialog has a box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await checkTouchTargets(page, '[role="dialog"], [role="alertdialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  watch.assertClean();
});
