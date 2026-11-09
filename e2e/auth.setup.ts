import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { checkNarrowPage, reportTiming, watchPage } from "./checks";
import { AUTH_DIR, createSmokeFixtures } from "./fixtures";

setup("sign-in works at 360 px", async ({ page }) => {
  const fixtures = await createSmokeFixtures();
  const watch = watchPage(page);

  await page.goto("/login");
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });
  // On a touch screen typed text is 16 px, so the browser does not zoom
  // into the field (the coarse-pointer rule in globals.css).
  await expect(email).toHaveCSS("font-size", "16px");
  await expect(password).toHaveCSS("font-size", "16px");
  await reportTiming(page, "Sign-in");

  await email.fill(fixtures.email);
  await password.fill(fixtures.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  await page.context().storageState({ path: path.join(AUTH_DIR, "manager.json") });
  watch.assertClean();
});
