import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { checkNarrowPage, watchPage } from "./checks";
import { AUTH_DIR, readSmokeFixtures, signInLinkFor } from "./fixtures";

// The tenant the smoke's fixtures created (e2e/fixtures.ts, RFC mgm#197)
// signs in by email link on a 360 px touch screen, as the manager does in
// auth.setup.ts, and lands on their home, /my: the (gui) layout sends a
// person whose rows are all tenant rows there from the start page.

setup("a tenant signs in at 360 px", async ({ page, baseURL }) => {
  const { tenantEmail } = readSmokeFixtures();
  if (!tenantEmail) throw new Error("[browser smoke] the fixtures name no tenant");
  // Asking for a sign-in link writes one rate-limit row (RFC #186); it is
  // the only write sign-in makes.
  const watch = await watchPage(page, { expectedWrites: [/^\/api\/auth\/sign-in-link$/] });

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(tenantEmail);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("on its way");
  const link = new URL(await signInLinkFor(tenantEmail));
  // The session cookie is set where the link lands, so it must be this app.
  expect(link.origin).toBe(new URL(baseURL!).origin);
  await page.goto(link.toString());
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL((url) => url.pathname === "/my");
  await expect(page.getByRole("main")).toBeVisible();
  await checkNarrowPage(page, { landmarks: true });

  await page.context().storageState({ path: path.join(AUTH_DIR, "tenant.json") });
  watch.assertClean();
});
