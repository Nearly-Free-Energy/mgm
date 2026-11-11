import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionSpec, FormProps, Json } from "../../contract";
import { ActionForm, fieldsOf, NO_FORM, type ActionFormProps } from "../action-form";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const FLAT: Json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    name: { type: "string", maxLength: 40, title: "Site name", description: "As households see it." },
    kind: { type: "string", enum: ["solar", "hybrid"], description: "System kind" },
    capacity_kw: { type: "number", minimum: 0, maximum: 500 },
    panels: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    metered: { type: "boolean" },
    opened_on: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    pin: { type: "string", writeOnly: true },
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
    tag: { type: "string" },
  },
  required: ["name", "kind", "capacity_kw", "panels", "metered", "opened_on", "pin", "note"],
  additionalProperties: false,
};

const BANDS: Json = {
  type: "object",
  properties: {
    bands: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: { from_hour: { type: "integer", minimum: 0, maximum: 23 }, rate: { type: "number" } },
        required: ["from_hour", "rate"],
      },
    },
  },
  required: ["bands"],
};

const spec = (input: Json, confirm: ActionSpec["confirm"] = "none"): ActionSpec => ({
  type: "spec",
  id: "metering.rename",
  title: "Save site",
  confirm,
  inputVersion: 1,
  input,
});

function mount(input: Json, over: Partial<ActionFormProps> = {}) {
  const submit = vi.fn<FormProps["submit"]>();
  const cancel = vi.fn();
  const props: ActionFormProps = {
    spec: spec(input),
    actionRef: { action: "metering.rename", params: {}, label: "Save", enabled: true },
    model: null,
    initial: null,
    busy: false,
    error: null,
    submit,
    cancel,
    ...over,
  };
  const view = render(<ActionForm {...props} />);
  return { submit, cancel, rerender: (more: Partial<ActionFormProps>) => view.rerender(<ActionForm {...props} {...more} />) };
}

const field = (name: string | RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save site" }));

describe("ActionForm", () => {
  it("renders each flat kind with its label, hint and required mark", () => {
    mount(FLAT);
    // Title first, then description, then the key.
    const name = field(/^Site name/);
    expect(name.maxLength).toBe(40);
    expect(name.getAttribute("aria-required")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("As households see it.")).toBeTruthy();
    expect(field(/^System kind/).tagName).toBe("SELECT");
    expect(within(field(/^System kind/)).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "solar", "hybrid"]);
    expect(field(/^Capacity kw/).inputMode).toBe("decimal");
    expect(field(/^Panels/).inputMode).toBe("numeric");
    expect(field(/^Metered/).type).toBe("checkbox");
    expect(field(/^Opened on/).type).toBe("date");
    expect(field(/^Pin/).type).toBe("password");
    expect(field(/^Pin/).autocomplete).toBe("new-password");
    expect(field(/^Tag/).getAttribute("aria-required")).toBeNull();
    // The visible mark, beside aria-required.
    expect(screen.getByText("Site name", { selector: "label" }).textContent).toContain("*");
    expect(screen.getByText("Tag", { selector: "label" }).textContent).not.toContain("*");
  });

  it("gives every button a 44 px target on coarse pointers", () => {
    mount(BANDS, { initial: { bands: [{ from_hour: 0, rate: 1 }, { from_hour: 6, rate: 2 }] } });
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button.className).toContain("pointer-coarse:min-h-11");
    cleanup();
    mount({ anyOf: [] });
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("pointer-coarse:min-h-11");
  });

  it("checks a number's minimum and trims a required text field before checking it", () => {
    const input: Json = { type: "object", properties: { label: { type: "string" }, n: { type: "number", minimum: 1 } }, required: ["label", "n"] };
    const { submit } = mount(input);
    fireEvent.change(field(/^Label/), { target: { value: "   " } });
    fireEvent.change(field(/^N/), { target: { value: "0" } });
    save();
    expect(screen.getByText("Enter a value.")).toBeTruthy();
    expect(screen.getByText("Enter 1 or more.")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("prefills from initial and defaults, never a secret, and submits typed values", () => {
    const input = { ...(FLAT as object), properties: { ...(FLAT as { properties: object }).properties, tag: { type: "string", default: "east" } } } as Json;
    const { submit } = mount(input, {
      initial: { name: "Kasenge", kind: "hybrid", capacity_kw: 12.5, panels: 30, metered: true, opened_on: "2026-01-02", pin: "1234", note: "x" },
    });
    expect(field(/^Pin/).value).toBe("");
    expect(field(/^Tag/).value).toBe("east");
    fireEvent.change(field(/^Pin/), { target: { value: "9999" } });
    fireEvent.change(field(/^Note/), { target: { value: "" } });
    save();
    expect(submit).toHaveBeenCalledWith({
      name: "Kasenge",
      kind: "hybrid",
      capacity_kw: 12.5,
      panels: 30,
      metered: true,
      opened_on: "2026-01-02",
      pin: "9999",
      note: null,
      tag: "east",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves an empty optional field out and refuses an empty required one", () => {
    const { submit } = mount(FLAT);
    save();
    expect(submit).not.toHaveBeenCalled();
    expect(field(/^Site name/).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field(/^Site name/));
    expect(screen.getByText("Choose an option.")).toBeTruthy();

    fireEvent.change(field(/^Site name/), { target: { value: "Kasenge" } });
    fireEvent.change(field(/^System kind/), { target: { value: "0" } });
    fireEvent.change(field(/^Capacity kw/), { target: { value: "abc" } });
    fireEvent.change(field(/^Panels/), { target: { value: "2.5" } });
    fireEvent.change(field(/^Opened on/), { target: { value: "2026-01-02" } });
    fireEvent.change(field(/^Pin/), { target: { value: "1" } });
    save();
    expect(screen.getByText("Enter a number.")).toBeTruthy();
    expect(screen.getByText("Enter a whole number.")).toBeTruthy();
    fireEvent.change(field(/^Capacity kw/), { target: { value: "600" } });
    fireEvent.change(field(/^Panels/), { target: { value: "3" } });
    save();
    expect(screen.getByText("Enter 500 or less.")).toBeTruthy();
    fireEvent.change(field(/^Capacity kw/), { target: { value: "5" } });
    save();
    expect(submit).toHaveBeenCalledWith({
      name: "Kasenge",
      kind: "solar",
      capacity_kw: 5,
      panels: 3,
      metered: false,
      opened_on: "2026-01-02",
      pin: "1",
      note: null,
    });
  });

  it("adds and removes labelled rows within the array's bounds", () => {
    const { submit } = mount(BANDS, { initial: { bands: [{ from_hour: 0, rate: 500 }] } });
    const rows = () => screen.getAllByRole("group", { name: /^Bands, row/ });
    expect(rows()).toHaveLength(1);
    // At minItems a row cannot be removed.
    expect((screen.getByRole("button", { name: "Remove Bands, row 1" }) as HTMLButtonElement).disabled).toBe(true);
    const add = screen.getByRole("button", { name: "Add a row to Bands" }) as HTMLButtonElement;
    fireEvent.click(add);
    // The new row's first field takes focus.
    expect(document.activeElement).toBe(within(rows()[1]).getByLabelText(/^From hour/));
    fireEvent.click(add);
    expect(rows()).toHaveLength(3);
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Bands, row 2" }));
    expect(rows()).toHaveLength(2);
    expect(add.disabled).toBe(false);
    // Focus moves to what took the removed row's place.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Bands, row 2" }));
    const second = within(rows()[1]);
    fireEvent.change(second.getByLabelText(/^From hour/), { target: { value: "18" } });
    fireEvent.change(second.getByLabelText(/^Rate/), { target: { value: "650.5" } });
    save();
    expect(submit).toHaveBeenCalledWith({ bands: [{ from_hour: 0, rate: 500 }, { from_hour: 18, rate: 650.5 }] });
  });

  it("moves focus on Remove to the previous row, or to Add, and lets a list without minItems empty", () => {
    const { minItems, ...bands } = (BANDS as { properties: { bands: Record<string, Json> } }).properties.bands;
    expect(minItems).toBe(1);
    const input: Json = { ...(BANDS as Record<string, Json>), properties: { bands } };
    const { submit } = mount(input, { initial: { bands: [{ from_hour: 0, rate: 1 }, { from_hour: 6, rate: 2 }] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Bands, row 2" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Bands, row 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Bands, row 1" }));
    expect(screen.queryAllByRole("group", { name: /^Bands, row/ })).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a row to Bands" }));
    save();
    expect(submit).toHaveBeenCalledWith({ bands: [] });
  });

  it("focuses the field the route names, also when the error comes without a remount", () => {
    const { rerender } = mount(FLAT, { busy: true });
    expect(document.activeElement).not.toBe(field(/^Capacity kw/));
    rerender({ busy: false, error: { message: "Too large for this site.", field: "capacity_kw" } });
    expect(document.activeElement).toBe(field(/^Capacity kw/));
    expect(field(/^Capacity kw/).getAttribute("aria-describedby")).toContain(screen.getByText("Too large for this site.").id);
  });

  it("caps an array's maxItems at 100 rows", () => {
    const input: Json = { type: "object", properties: { a: { type: "array", maxItems: 1000, items: { type: "object", properties: { b: { type: "string" } } } } } };
    expect(fieldsOf(input)).toMatchObject([{ kind: "rows", minItems: 0, maxItems: 100 }]);
  });

  const MANY: Json = { type: "object", properties: { a: { type: "array", maxItems: 1000, items: { type: "object", properties: { b: { type: "string" } } } } } };
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ b: `row ${i}` }));

  it.each<[string, Json, Json]>([
    ["more initial rows than the form renders", MANY, { a: rowsOf(101) }],
    ["more initial rows than the array's maxItems", BANDS, { bands: rowsOf(4).map((_, i) => ({ from_hour: i, rate: 1 })) }],
  ])("offers Cancel only, sending nothing, for %s", (_, input, initial) => {
    const bound: { read: (() => Json | null) | null } = { read: null };
    const { submit } = mount(input, { initial, footer: <div data-testid="host-footer" />, bind: (r) => void (bound.read = r) });
    expect(screen.getByText(NO_FORM)).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
    expect(screen.queryByTestId("host-footer")).toBeNull();
    expect(bound.read?.() ?? null).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("renders and submits every initial row when they fill the form exactly", () => {
    const { submit } = mount(MANY, { initial: { a: rowsOf(100) } });
    expect(screen.getAllByRole("group", { name: /^A, row/ })).toHaveLength(100);
    save();
    expect(submit).toHaveBeenCalledWith({ a: rowsOf(100) });
  });

  it("shows the route's error at its field, a row's cell, or above the buttons", () => {
    const { rerender } = mount(BANDS, { initial: { bands: [{ from_hour: 0, rate: 1 }, { from_hour: 6, rate: 2 }] }, error: { message: "Rates overlap.", field: "bands.1.rate" } });
    const second = within(screen.getByRole("group", { name: "Bands, row 2" }));
    expect(second.getByText("Rates overlap.")).toBeTruthy();
    expect(second.getByLabelText(/^Rate/).getAttribute("aria-invalid")).toBe("true");
    // The cell in error takes focus, so the error is announced.
    expect(document.activeElement).toBe(second.getByLabelText(/^Rate/));
    expect(screen.getAllByText("Rates overlap.")).toHaveLength(1);

    rerender({ error: { message: "Bands must cover the day.", field: "bands" } });
    const whole = screen.getByText("Bands must cover the day.");
    const fieldset = whole.closest("fieldset")!;
    expect(fieldset.getAttribute("aria-describedby")).toBe(whole.id);
    expect(whole.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(within(fieldset).getAllByLabelText(/^From hour/)[0]);

    rerender({ error: { message: "The period is closed." } });
    expect(screen.getByRole("alert").textContent).toBe("The period is closed.");
  });

  it.each<[string, Json]>([
    ["a union", { anyOf: [{ type: "object", properties: {} }, { type: "object", properties: {} }] }],
    ["a nested object", { type: "object", properties: { a: { type: "object", properties: {} } } }],
    ["an array of strings", { type: "object", properties: { a: { type: "array", items: { type: "string" } } } }],
    ["an array of nested arrays", { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "array", items: { type: "string" } } } } } } }],
    ["a record", { type: "object", properties: {}, additionalProperties: { type: "string" } }],
    ["a mixed enum", { type: "object", properties: { a: { enum: ["x", true] } } }],
    ["an array of records", { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "string" } }, additionalProperties: { type: "string" } } } } }],
    ["an array of empty objects", { type: "object", properties: { a: { type: "array", items: { type: "object", properties: {} } } } }],
  ])("offers Cancel only for %s", (_, input) => {
    const { cancel } = mount(input);
    expect(screen.getByText(NO_FORM)).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns null from fieldsOf for every shape it cannot render", () => {
    expect(fieldsOf({ type: "object", properties: { a: { type: "string" } }, patternProperties: {} })).toBeNull();
    expect(fieldsOf({ type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } } })).toBeNull();
    expect(fieldsOf({ type: "object", properties: { a: { type: "string" } } })).toHaveLength(1);
  });

  it("cancels on Escape and from Cancel, and labels its own button by level", () => {
    const { cancel } = mount(FLAT, { spec: spec(FLAT, "typed") });
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    fireEvent.keyDown(field(/^Site name/), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("disables everything while busy", () => {
    const { submit } = mount(BANDS, { busy: true });
    for (const control of screen.getAllByRole("textbox")) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
    save();
    expect(submit).not.toHaveBeenCalled();
  });

  it("with the host's footer, shows it in place of its button, submits nothing on Enter and reads through bind", () => {
    let read: (() => Json | null) | null = null;
    const bind = vi.fn((r: (() => Json | null) | null) => void (read = r));
    const { submit } = mount(FLAT, {
      initial: { name: "Kasenge", kind: "solar", capacity_kw: 1, panels: 1, opened_on: "2026-01-02" },
      footer: <div data-testid="host-footer" />,
      bind,
    });
    expect(screen.getByTestId("host-footer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save site" })).toBeNull();
    fireEvent.submit(field(/^Site name/).closest("form")!);
    expect(submit).not.toHaveBeenCalled();
    // The secret is empty: the read shows why and gives nothing.
    const reads: (Json | null)[] = [];
    act(() => void reads.push(read!()));
    expect(reads[0]).toBeNull();
    expect(field(/^Pin/).getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field(/^Pin/), { target: { value: "1" } });
    act(() => void reads.push(read!()));
    expect(reads[1]).toMatchObject({ name: "Kasenge", pin: "1", note: null });
    expect(submit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
