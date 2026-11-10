/**
 * markSynthetic marks every Value a view kind's body holds, and nothing else.
 */
import { describe, expect, it } from "vitest";
import type { Value } from "../contract";
import { markSynthetic } from "../mark-synthetic";
import type { LoadedModel } from "../surface";

const v = (text: string): Value => ({ t: "text", text });
const marked = (text: string): Value => ({ t: "text", text, synthetic: true });

describe("markSynthetic", () => {
  it("marks tile values and statuses, and leaves series alone", () => {
    const model: LoadedModel<"metrics"> = {
      title: "T",
      actions: [],
      body: {
        tiles: [
          { key: "a", label: "A", value: v("1"), status: { t: "status", v: "x", tone: "warning", text: "X" } },
          { key: "b", label: "B", value: v("2") },
        ],
        series: [{ key: "s", label: "S", unit: "%", points: [["2026-11-05T00:00:00.000Z", 1]] }],
      },
    };
    const out = markSynthetic(model);
    expect(out.body.tiles[0]).toEqual({
      key: "a",
      label: "A",
      value: marked("1"),
      status: { t: "status", v: "x", tone: "warning", text: "X", synthetic: true },
    });
    expect(out.body.tiles[1]).toEqual({ key: "b", label: "B", value: marked("2") });
    expect(out.body.series).toEqual(model.body.series);
    // The input is not changed.
    expect(model.body.tiles[1].value).toEqual(v("2"));
  });

  it("marks cells and totals, record fields, and a feed entry's Values in its text and its embed", () => {
    const collection: LoadedModel<"collection"> = {
      title: "T",
      actions: [],
      body: {
        columns: [],
        rows: [{ id: "r", cells: { a: v("1") }, actions: [] }],
        totals: { a: v("9") },
        empty: { title: "None" },
      },
    };
    expect(markSynthetic(collection).body).toMatchObject({ rows: [{ cells: { a: marked("1") } }], totals: { a: marked("9") } });

    const record: LoadedModel<"record"> = {
      title: "T",
      actions: [],
      body: { sections: [{ title: "S", fields: [{ key: "a", label: "A", value: v("1") }] }] },
    };
    expect(markSynthetic(record).body.sections[0].fields[0].value).toEqual(marked("1"));

    const at = "2026-11-05T00:00:00.000Z";
    const feed: LoadedModel<"feed"> = {
      title: "T",
      actions: [],
      body: {
        entries: [
          { id: "1", at, author: { kind: "system", name: "S" }, text: [], embed: { type: "values", values: [v("1")] } },
          { id: "2", at, author: { kind: "system", name: "S" }, text: [] },
          {
            id: "3",
            at,
            author: { kind: "system", name: "S" },
            text: [
              { p: ["Used ", { value: v("4.8 kWh") }, { link: "/x", text: "more" }] },
              { li: [{ value: v("2") }, { unverified: "3" }] },
            ],
          },
        ],
      },
    };
    const out = markSynthetic(feed).body.entries;
    expect(out[0].embed).toEqual({ type: "values", values: [marked("1")] });
    expect(out[1]).toEqual(feed.body.entries[1]);
    expect(out[2].text).toEqual([
      { p: ["Used ", { value: marked("4.8 kWh") }, { link: "/x", text: "more" }] },
      { li: [{ value: marked("2") }, { unverified: "3" }] },
    ]);
    // The input is not changed.
    expect(feed.body.entries[2].text[0]).toEqual({ p: ["Used ", { value: v("4.8 kWh") }, { link: "/x", text: "more" }] });
  });

  // A key no body kind declares today, standing in for a field a later
  // contract version adds: marking must copy it through, not rebuild the object.
  const kept = <T extends object>(o: T): T => ({ ...o, kept: "yes" });

  it("keeps every other key of each body kind, and of each object on the way to a Value", () => {
    const at = "2026-11-05T00:00:00.000Z";
    const series = [kept({ key: "s", label: "S", unit: "%", points: [[at, 1]] as [string, number | null][] })];
    const metrics: LoadedModel<"metrics"> = {
      title: "T",
      actions: [],
      body: kept({ tiles: [kept({ key: "a", label: "A", value: v("1"), hint: "h" })], series }),
    };
    const m = markSynthetic(metrics);
    expect(m.body).toEqual({
      kept: "yes",
      tiles: [{ kept: "yes", key: "a", label: "A", value: marked("1"), hint: "h" }],
      series,
    });
    // Series are left alone: the same array, points unmarked.
    expect(m.body.series).toBe(series);

    const collection: LoadedModel<"collection"> = {
      title: "T",
      actions: [],
      body: kept({
        columns: [{ key: "a", label: "A", type: "text", priority: 1 }],
        rows: [kept({ id: "r", cells: { a: v("1") }, actions: [] })],
        totals: { a: v("9") },
        filters: [],
        next: "/x?page=2",
        empty: { title: "None" },
      }),
    };
    expect(markSynthetic(collection).body).toEqual({
      ...collection.body,
      rows: [{ kept: "yes", id: "r", cells: { a: marked("1") }, actions: [] }],
      totals: { a: marked("9") },
    });

    const record: LoadedModel<"record"> = {
      title: "T",
      actions: [],
      body: kept({ sections: [kept({ title: "S", fields: [kept({ key: "a", label: "A", value: v("1") })] })] }),
    };
    expect(markSynthetic(record).body).toEqual({
      kept: "yes",
      sections: [{ kept: "yes", title: "S", fields: [{ kept: "yes", key: "a", label: "A", value: marked("1") }] }],
    });

    const feed: LoadedModel<"feed"> = {
      title: "T",
      actions: [],
      body: kept({
        busy: true,
        entries: [
          kept({
            id: "1",
            at,
            author: { kind: "system" as const, name: "S" },
            text: [kept({ p: [kept({ value: v("2") }), "and "] }), kept({ li: [kept({ value: v("3") })] })],
            embed: kept({ type: "values" as const, values: [v("1")] }),
          }),
        ],
      }),
    };
    expect(markSynthetic(feed).body).toEqual({
      kept: "yes",
      busy: true,
      entries: [
        {
          kept: "yes",
          id: "1",
          at,
          author: { kind: "system", name: "S" },
          text: [
            { kept: "yes", p: [{ kept: "yes", value: marked("2") }, "and "] },
            { kept: "yes", li: [{ kept: "yes", value: marked("3") }] },
          ],
          embed: { kept: "yes", type: "values", values: [marked("1")] },
        },
      ],
    });

    const flow: LoadedModel<"flow"> = {
      title: "T",
      actions: [],
      body: kept({ steps: [kept({ id: "a", title: "A", state: "current" as const })] }),
    };
    expect(markSynthetic(flow).body).toEqual(flow.body);
  });
});
