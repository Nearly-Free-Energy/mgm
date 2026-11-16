import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { reportTiming, watchPage } from "./checks";
import { readSmokeFixtures } from "./fixtures";

// Signed in as the smoke's organization manager (auth.setup.ts), on a
// 360 px touch screen (playwright.config.ts). The two things on a page that
// load from somewhere other than the app's own scripts and styles: the
// invoice logo, from a signed Supabase Storage URL, and the PDF preview, a
// blob: document in a popup. watchPage fails the test on a content security
// policy violation in either page (decision 19 on #115).

test("the invoice page shows the logo and previews the PDF at 360 px", async ({ page }) => {
  const { communityId } = readSmokeFixtures();
  const watch = await watchPage(page);
  await page.goto(`/communities/${communityId}/invoice`);
  await expect(page.getByRole("heading", { name: "Configure Smoke community's invoice template" })).toBeVisible();
  await reportTiming(page, "Invoice branding");

  // The logo the fixtures uploaded, loaded from its signed URL.
  const logo = page.getByRole("img", { name: "Current logo" });
  await expect(logo).toBeVisible();
  const src = await logo.getAttribute("src");
  expect(new URL(src ?? "", page.url()).origin, "the logo comes from Supabase Storage").toBe(
    new URL(process.env.MGM_PUBLIC_SUPABASE_URL ?? "").origin
  );
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(8);

  // Preview bill opens about:blank, posts the form, and points the popup
  // at a blob: URL of the PDF it gets back (invoice-shell.tsx, handlePreview).
  // chrome-headless-shell, which this smoke runs, has no PDF viewer, so the
  // popup saves that document as a download where Chrome would display it;
  // the download carries the URL the popup was sent to and its content.
  const preview = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/communities/${communityId}/invoice-preview`
  );
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview bill" }).click();
  const popup = await popupOpened;
  const downloaded = popup.waitForEvent("download");
  const response = await preview;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const download = await downloaded;
  const blobUrl = new URL(download.url());
  expect(blobUrl.protocol, "the popup was sent to a blob: URL").toBe("blob:");
  expect(blobUrl.pathname.startsWith(`${new URL(page.url()).origin}/`), "a blob: URL the app made").toBe(true);
  const saved = await download.path();
  expect(readFileSync(saved).subarray(0, 5).toString("latin1"), "the preview is a PDF").toBe("%PDF-");

  // The button settles once the popup has been pointed at the PDF.
  await expect(page.getByRole("button", { name: "Preview bill" })).toBeEnabled();
  await expect(page.getByText(/Preview failed|Network error/)).toHaveCount(0);
  watch.assertClean();
});
