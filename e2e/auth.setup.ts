import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { checkNarrowPage, reportTiming, watchPage } from "./checks";
import { AUTH_DIR, createSmokeFixtures, signInLinkFor } from "./fixtures";

setup("sign-in works at 360 px", async ({ page, baseURL }) => {
  const fixtures = await createSmokeFixtures();
  // Asking for a sign-in link writes one rate-limit row (RFC #186); it is
  // the only write sign-in makes.
  const watch = await watchPage(page, { expectedWrites: [/^\/api\/auth\/sign-in-link$/] });

  await page.goto("/login");
  const email = page.getByLabel("Email", { exact: true });
  await expect(email).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });
  // On a touch screen typed text is 16 px, so the browser does not zoom
  // into the field (the coarse-pointer rule in globals.css).
  await expect(email).toHaveCSS("font-size", "16px");
  await reportTiming(page, "Sign-in");

  // Sign-in by email link (RFC #186): the link arrives in the mail catcher.
  await email.fill(fixtures.email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("on its way");
  const link = new URL(await signInLinkFor(fixtures.email));
  // The session cookie is set where the link lands, so it must be this app.
  expect(link.origin).toBe(new URL(baseURL!).origin);
  await page.goto(link.toString());
  await checkNarrowPage(page, { landmarks: false });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  await page.context().storageState({ path: path.join(AUTH_DIR, "manager.json") });
  watch.assertClean();
});
