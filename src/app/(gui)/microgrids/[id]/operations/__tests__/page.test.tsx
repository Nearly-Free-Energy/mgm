// Microgrid Operations page — server component tests.
//
// The page resolves the day and hands it to two children: the DayPicker and
// a Suspense boundary (keyed on the day) around SiteDaySection, which reads
// the day itself. SiteDaySection's own behaviour is covered in
// site-day-section.test.tsx.
//
// Strategy:
//   - Mock @/lib/supabase/server to return a fixture microgrid row.
//   - Mock @/lib/metering/compose so the async SiteDaySection child does not
//     reach a real capability if React starts rendering it.
//   - Mock @/lib/hierarchy so HierarchyNav doesn't need a full Supabase chain.
//   - Fake the clock (Date only) so "today" and "yesterday" are fixed in the
//     microgrid's timezone.
//   - Call OperationsPage() directly (async server component) and inspect
//     the returned element tree: the date reaches SiteDaySection and the
//     DayPicker as props. Serialised with renderToStaticMarkup, the async
//     child suspends, so the markup carries the Suspense fallback.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React, { Suspense } from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const { composeMeteringMock, notFoundMock } = vi.hoisted(() => ({
  composeMeteringMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: composeMeteringMock,
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    title,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    title?: string;
  }) => React.createElement("a", { href, className, title }, children),
}));

// ── Import page (after mocks) ─────────────────────────────────────────────────

import OperationsPage from "../page";
import { SiteDayLoading, SiteDaySection } from "../site-day-section";
import { DayPicker } from "@/components/operations/day-picker";

// ── Query builder helpers ─────────────────────────────────────────────────────
//
// buildQuery returns a fully chainable proxy so any call chain (select, eq,
// maybeSingle, etc.) resolves to { data, error: null }.

function buildQuery(data: unknown) {
  const terminal = () => Promise.resolve({ data, error: null });

  function makeChainable(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "maybeSingle" || prop === "single" || prop === "returns") {
          return terminal;
        }
        if (prop === "then") {
          return (resolve: (v: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data, error: null }).then(resolve);
        }
        return () => makeChainable();
      },
    });
  }

  return makeChainable();
}

function makeFrom(microgridRow: unknown) {
  return (table: string) => {
    if (table === "microgrids") return buildQuery(microgridRow);
    return buildQuery([]);
  };
}

// ── Element-tree helpers ──────────────────────────────────────────────────────

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Every element in `node` (depth first) whose type is `type`. */
function findAll(node: React.ReactNode, type: unknown): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, type));
  if (!React.isValidElement(node)) return [];
  const element = node as AnyElement;
  const here = element.type === type ? [element] : [];
  return [...here, ...findAll(element.props.children as React.ReactNode, type)];
}

function findOne(node: React.ReactNode, type: unknown): AnyElement {
  const found = findAll(node, type);
  expect(found).toHaveLength(1);
  return found[0];
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MICROGRID = {
  id: "mg-1",
  timezone: "Africa/Kampala",
  communities: { org_id: "org-1" },
};

// 22:30 UTC on 6 Nov is 01:30 on 7 Nov in Kampala (UTC+3): today there is
// 2026-11-07 and yesterday 2026-11-06, while UTC would say 2026-11-05.
const NOW = new Date("2026-11-06T22:30:00Z");
const TODAY = "2026-11-07";
const YESTERDAY = "2026-11-06";
const BASE = "/microgrids/mg-1/operations";

async function callPage(date?: string | string[]): Promise<React.ReactNode> {
  return OperationsPage({
    params: Promise.resolve({ id: "mg-1" }),
    searchParams: Promise.resolve(date === undefined ? {} : { date }),
  });
}

/** The day the page hands to SiteDaySection. */
async function sectionDate(date?: string | string[]): Promise<string> {
  const tree = await callPage(date);
  return findOne(tree, SiteDaySection).props.date as string;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OperationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockFrom.mockImplementation(makeFrom(MICROGRID));
    // Never resolves: the section stays suspended, as it would while
    // OpenEMS answers.
    composeMeteringMock.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to yesterday in the microgrid's timezone", async () => {
    expect(await sectionDate()).toBe(YESTERDAY);
  });

  it("hands SiteDaySection the organization, the microgrid and the day", async () => {
    const tree = await callPage();
    expect(findOne(tree, SiteDaySection).props).toEqual({
      organizationId: "org-1",
      microgridId: "mg-1",
      date: YESTERDAY,
    });
  });

  it("hands the DayPicker the base path, the day and today", async () => {
    const tree = await callPage();
    expect(findOne(tree, DayPicker).props).toEqual({
      basePath: BASE,
      date: YESTERDAY,
      today: TODAY,
    });
  });

  it("wraps SiteDaySection in a Suspense boundary keyed on the day, with the loading fallback", async () => {
    const tree = await callPage("2026-10-15");
    const boundary = findOne(tree, Suspense);
    expect(boundary.key).toBe("2026-10-15");
    expect(React.isValidElement(boundary.props.fallback)).toBe(true);
    expect((boundary.props.fallback as AnyElement).type).toBe(SiteDayLoading);
    expect(findAll(boundary.props.children as React.ReactNode, SiteDaySection)).toHaveLength(1);
    // The DayPicker sits outside the boundary, so it stays while a day loads.
    expect(findAll(boundary.props.children as React.ReactNode, DayPicker)).toHaveLength(0);
  });

  it("renders the day picker and the loading placeholder while the day is read", async () => {
    const html = renderToStaticMarkup((await callPage()) as React.ReactElement);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading the day&#x27;s operations"');
    // The day picker renders in full.
    expect(html).toContain(`value="${YESTERDAY}"`);
    expect(html).toContain(`max="${TODAY}"`);
    expect(html).toContain(`${BASE}?date=${TODAY}`);
    // No figures yet.
    expect(html).not.toContain("Battery level (%)");
  });

  it("falls back to UTC when the stored timezone is not supported", async () => {
    mockFrom.mockImplementation(makeFrom({ ...MICROGRID, timezone: "Mars/Olympus" }));
    const tree = await callPage();

    // UTC today is 2026-11-06, so yesterday is 2026-11-05.
    expect(findOne(tree, SiteDaySection).props.date).toBe("2026-11-05");
    expect(findOne(tree, DayPicker).props.today).toBe("2026-11-06");
  });

  it("passes a valid past ?date= through", async () => {
    expect(await sectionDate("2026-10-15")).toBe("2026-10-15");
  });

  it("accepts today itself", async () => {
    const tree = await callPage(TODAY);
    expect(findOne(tree, SiteDaySection).props.date).toBe(TODAY);
    expect(findOne(tree, DayPicker).props.date).toBe(TODAY);
  });

  it.each([
    ["a future day", "2026-11-08"],
    ["a day far in the future", "2030-01-01"],
    ["a non-date string", "yesterday"],
    ["a date with a time", "2026-11-01T00:00"],
    ["a short year", "26-11-01"],
    ["an empty string", ""],
  ])("falls back to yesterday for %s", async (_label, date) => {
    const tree = await callPage(date);
    expect(findOne(tree, SiteDaySection).props.date).toBe(YESTERDAY);
    expect(findOne(tree, DayPicker).props.date).toBe(YESTERDAY);
  });

  it("falls back to yesterday when ?date= is repeated", async () => {
    expect(await sectionDate(["2026-10-01", "2026-10-02"])).toBe(YESTERDAY);
  });

  // YYYY-MM-DD shaped but not a calendar day: neither the picker nor the
  // section ever sees them.
  it.each([
    ["month 13", "2025-13-01"],
    ["month 00", "2026-00-10"],
    ["30 February", "2026-02-30"],
  ])("falls back to yesterday for a non-existent day (%s)", async (_label, date) => {
    const tree = await callPage(date);
    expect(findOne(tree, SiteDaySection).props.date).toBe(YESTERDAY);
    expect(findOne(tree, DayPicker).props.date).toBe(YESTERDAY);
  });

  it("does not read the day itself", async () => {
    await callPage();
    expect(composeMeteringMock).not.toHaveBeenCalled();
  });

  it("calls notFound() for an unknown microgrid", async () => {
    mockFrom.mockImplementation(makeFrom(null));

    await expect(callPage()).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
    expect(composeMeteringMock).not.toHaveBeenCalled();
  });
});
