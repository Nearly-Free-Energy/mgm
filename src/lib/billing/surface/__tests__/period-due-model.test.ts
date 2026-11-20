/**
 * The `billing.period-due` signals: a draft period counts once its last day
 * has passed in its own time zone; one with bills asks to be closed, one
 * without asks for its bills; oldest first, capped; fixed copy with no
 * tenant, amount or id in the text.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { signalOutSchema } from "@/lib/gui/host/server/model-schema";
import { MAX_SIGNALS_PER_SOURCE } from "@/lib/gui/surface";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import { PERIOD_DUE_EXAMPLES } from "../period-due-examples";
import { buildPeriodDueSignals, hasEnded, type DuePeriodInput } from "../period-due-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7f00000-0000-4000-8000-0000000000a1";
const period = (over: Partial<DuePeriodInput> = {}): DuePeriodInput => ({
  id: "e7f00000-0000-4000-8000-0000000000b1",
  microgridId: MG,
  microgridName: "North site",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  timezone: "Africa/Kampala",
  bills: 4,
  ...over,
});

describe("hasEnded", () => {
  it("counts a period's last day as passed only once the next day has begun in its own zone", () => {
    // 2026-10-31T21:00Z is midnight of 1 November in Kampala (UTC+3).
    expect(hasEnded(period(), new Date("2026-10-31T20:59:59Z"))).toBe(false);
    expect(hasEnded(period(), new Date("2026-10-31T21:00:00Z"))).toBe(true);
    expect(hasEnded(period({ timezone: "UTC" }), new Date("2026-10-31T23:59:59Z"))).toBe(false);
    expect(hasEnded(period({ timezone: "America/Los_Angeles" }), new Date("2026-11-01T06:59:59Z"))).toBe(false);
    expect(hasEnded(period({ timezone: "America/Los_Angeles" }), new Date("2026-11-01T07:00:00Z"))).toBe(true);
  });

  it("reads a zone the runtime cannot resolve as UTC", () => {
    expect(hasEnded(period({ timezone: "Kampala" }), new Date("2026-10-31T23:59:59Z"))).toBe(false);
    expect(hasEnded(period({ timezone: "Kampala" }), new Date("2026-11-01T00:00:00Z"))).toBe(true);
  });
});

describe("buildPeriodDueSignals", () => {
  const NOW = new Date("2026-11-20T09:00:00Z");

  it("asks to close a period with bills, at its close checklist", () => {
    expect(buildPeriodDueSignals(fmt, [period()], NOW)).toEqual([
      {
        id: "e7f00000-0000-4000-8000-0000000000b1",
        kind: "your-move",
        severity: "warn",
        title: "North site: October 2026 is not closed",
        facts: [{ t: "text", text: "1 Oct 2026 – 31 Oct 2026" }],
        entity: { kind: "microgrid", id: MG, label: "North site" },
        href: `/microgrids/${MG}/billing/e7f00000-0000-4000-8000-0000000000b1/close`,
        at: "2026-10-31T21:00:00.000Z",
        due: "2026-11-01",
      },
    ]);
  });

  it("asks for the bills of a period with none, at its review", () => {
    const [signal] = buildPeriodDueSignals(fmt, [period({ bills: 0 })], NOW);
    expect([signal.title, signal.href]).toEqual([
      "North site: October 2026 has no bills",
      `/microgrids/${MG}/billing/e7f00000-0000-4000-8000-0000000000b1`,
    ]);
  });

  it("names a period that is not a whole month by its dates", () => {
    const [signal] = buildPeriodDueSignals(fmt, [period({ startDate: "2026-10-05", endDate: "2026-11-04" })], NOW);
    expect(signal.title).toBe("North site: 5 October to 4 November 2026 is not closed");
  });

  it("leaves out a period that has not ended, and lists the rest oldest first", () => {
    const ids = buildPeriodDueSignals(
      fmt,
      [
        period({ id: "october", endDate: "2026-10-31" }),
        period({ id: "running", startDate: "2026-11-01", endDate: "2026-11-30" }),
        period({ id: "september", startDate: "2026-09-01", endDate: "2026-09-30" }),
        // Ends today in Kampala: not yet due.
        period({ id: "today", startDate: "2026-11-01", endDate: "2026-11-20" }),
      ],
      NOW,
    ).map((s) => s.id);
    expect(ids).toEqual(["september", "october"]);
  });

  it(`stops at ${MAX_SIGNALS_PER_SOURCE}, keeping the oldest`, () => {
    // Given newest first, so the cut is shown to keep the oldest, not the first given.
    const many = Array.from({ length: MAX_SIGNALS_PER_SOURCE + 5 }, (_, i) =>
      period({ id: `p${i}`, startDate: "2020-01-01", endDate: addDaysToDateKey("2021-01-01", MAX_SIGNALS_PER_SOURCE + 4 - i) }),
    );
    const out = buildPeriodDueSignals(fmt, many, NOW);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0].due).toBe("2021-01-02");
    expect(out.at(-1)?.due).toBe(addDaysToDateKey("2021-01-02", MAX_SIGNALS_PER_SOURCE - 1));
  });

  it("returns signals a watcher may send, as the examples are", () => {
    for (const s of [...buildPeriodDueSignals(fmt, [period(), period({ id: "x", bills: 0 })], NOW), ...PERIOD_DUE_EXAMPLES]) {
      expect(signalOutSchema.safeParse(s).success).toBe(true);
    }
    expect(PERIOD_DUE_EXAMPLES.map((s) => s.title)).toEqual(["Kiwumu: September 2026 has no bills", "Kiwumu: October 2026 is not closed"]);
  });
});
