import { test as teardown } from "@playwright/test";
import { deleteSmokeFixtures } from "./fixtures";

teardown("delete the smoke's rows", async () => {
  await deleteSmokeFixtures();
});
