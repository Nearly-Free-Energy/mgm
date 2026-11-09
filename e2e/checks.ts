import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { TOUCH_TALL, TOUCH_WIDE } from "./touch-selectors";

/**
 * Collects page errors, console errors, requests to any origin other than
 * the app and its Supabase, and writes (non-GET requests to the app's /api).
 */
export function watchPage(page: Page) {
  const app = new URL(String(test.info().project.use.baseURL)).origin;
  const allowed = new Set([app, new URL(process.env.MGM_PUBLIC_SUPABASE_URL ?? app).origin]);
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  // No allowlist. If an error proves unavoidable, match it here with a
  // comment that says why.
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.protocol.startsWith("http")) return; // data: and blob: URLs
    if (!allowed.has(url.origin)) problems.push(`request to ${url.origin}`);
    if (url.origin === app && url.pathname.startsWith("/api/") && request.method() !== "GET") {
      problems.push(`write: ${request.method()} ${url.pathname}`);
    }
  });
  return { assertClean: () => expect(problems).toEqual([]) };
}

/** Every rendered control under `root` is at least 44 px tall (and wide). */
export async function checkTouchTargets(page: Page, root = "body") {
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch is the primary pointer").toBe(true);
  const small = await page.evaluate(
    ([root, tall, wide]) =>
      Array.from(document.querySelector(root)?.querySelectorAll<HTMLElement>(tall) ?? [])
        .filter((el) => {
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (box.width === 0 || box.height === 0 || style.visibility === "hidden") return false;
          // A min-h-* or min-w-* utility keeps a control smaller on purpose:
          // the 44 px rule is in the base layer so that a utility wins.
          const ownHeight = /(^|\s)min-h-/.test(el.className) && parseFloat(style.minHeight) < 44;
          const ownWidth = /(^|\s)min-w-/.test(el.className) && parseFloat(style.minWidth) < 44;
          return (!ownHeight && box.height < 43.5) || (!ownWidth && el.matches(wide) && box.width < 43.5);
        })
        .map((el) => {
          const box = el.getBoundingClientRect();
          const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
          return `${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`;
        }),
    [root, TOUCH_TALL, TOUCH_WIDE] as const
  );
  expect(small, "controls under 44 px on a touch screen").toEqual([]);
}

/**
 * The page never scrolls sideways, every table sits in a box of its own
 * that scrolls sideways within the screen, and every control is a 44 px
 * target. Signed-in pages also have a visible main and navigation landmark.
 */
export async function checkNarrowPage(page: Page, { landmarks = true } = {}) {
  // Measured after load, and only once two samples half a second apart
  // agree, so a page that widens while it hydrates is not passed early.
  await page.waitForLoadState("load");
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const overflow = () => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth;
          const first = overflow();
          await new Promise((resolve) => setTimeout(resolve, 500));
          return Math.max(first, overflow());
        }),
      { message: "the page scrolls sideways" }
    )
    .toBeLessThanOrEqual(0);
  if (landmarks) {
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  }
  const looseTables = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table"))
      .filter((table) => table.getBoundingClientRect().width > 0)
      .filter((table) => {
        let box = table.parentElement;
        while (box && box !== document.body && !/^(auto|scroll)$/.test(getComputedStyle(box).overflowX)) {
          box = box.parentElement;
        }
        return !box || box === document.body || box.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5;
      })
      .map((table) => table.caption?.textContent?.trim() || "a table without a caption")
  );
  expect(looseTables, "tables not inside a sideways-scrolling box").toEqual([]);
  await checkTouchTargets(page);
}

const TIMINGS_HEADER =
  "\n### Browser smoke timings (reported, not enforced)\n\n" +
  "| Page | First byte (ms) | DOM ready (ms) | Load (ms) | Document, compressed (bytes) |\n|---|---|---|---|---|\n";

/**
 * Prints the page's load timings and the compressed size of its HTML (which
 * carries the server-rendered payload), and adds them to the job summary in CI.
 */
export async function reportTiming(page: Page, label: string) {
  await page.waitForLoadState("load");
  const t = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return [nav.responseStart, nav.domContentLoadedEventEnd, nav.loadEventEnd, nav.encodedBodySize].map(Math.round);
  });
  console.log(`[timing] ${label}: first byte ${t[0]} ms, DOM ready ${t[1]} ms, load ${t[2]} ms, document ${t[3]} B`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  // One descriptor for the read and both appends ("a+" creates the file if
  // needed), so nothing is checked by path before it is written.
  const fd = openSync(summary, "a+");
  try {
    if (!readFileSync(fd, "utf8").includes(TIMINGS_HEADER)) appendFileSync(fd, TIMINGS_HEADER);
    appendFileSync(fd, `| ${label} | ${t.join(" | ")} |\n`);
  } finally {
    closeSync(fd);
  }
}
