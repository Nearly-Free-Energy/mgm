// @vitest-environment jsdom
/**
 * GridTariffEditor — the grid tariff versions and savings settings on
 * Setup > Rates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GridTariffEditor, hourLabel } from "../GridTariffEditor";
import { LocaleProvider } from "../format/locale-context";
import type { GridTariff, MicrogridSavingsSettings } from "@/lib/types/domain";

const refreshSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

const MICROGRID_ID = "660e8400-e29b-41d4-a716-446655440001";
const TODAY = "2026-11-06";

const OLD: GridTariff = {
  id: "11111111-1111-4111-8111-111111111111",
  microgrid_id: MICROGRID_ID,
  effective_from: "2026-01-01",
  bands: [
    { from_hour: 0, to_hour: 6, rate: 400 },
    { from_hour: 6, to_hour: 18, rate: 550 },
    { from_hour: 18, to_hour: 24, rate: 650 },
  ],
  created_at: "2026-01-01T00:00:00Z",
};

const CURRENT: GridTariff = {
  ...OLD,
  id: "22222222-2222-4222-8222-222222222222",
  effective_from: "2026-07-01",
  bands: [{ from_hour: 0, to_hour: 24, rate: 500.25 }],
};

const SCHEDULED: GridTariff = {
  ...OLD,
  id: "33333333-3333-4333-8333-333333333333",
  effective_from: "2027-01-01",
};

const SETTINGS: MicrogridSavingsSettings = {
  microgrid_id: MICROGRID_ID,
  solar_savings_from: "2026-10-01",
  arbitrage_from: null,
  round_trip_efficiency: 0.85,
  updated_at: "2026-10-01T00:00:00Z",
};

function renderEditor({
  tariffs = [OLD, CURRENT, SCHEDULED],
  settings = SETTINGS,
  canManage = true,
}: {
  tariffs?: GridTariff[];
  settings?: MicrogridSavingsSettings | null;
  canManage?: boolean;
} = {}) {
  return render(
    <LocaleProvider locale="en" currency="UGX">
      <GridTariffEditor
        microgridId={MICROGRID_ID}
        currency="UGX"
        tariffs={tariffs}
        settings={settings}
        today={TODAY}
        canManage={canManage}
      />
    </LocaleProvider>
  );
}

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/ /g, " ");
}

function versionItems(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Grid tariff versions" });
  return within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
}

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Add version" }));
  return screen.getByRole("form", { name: "New grid tariff version" });
}

function setRates(rates: string[]) {
  rates.forEach((rate, i) => {
    fireEvent.change(screen.getByLabelText(`Band ${i + 1} rate`), { target: { value: rate } });
  });
}

beforeEach(() => {
  refreshSpy.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hourLabel", () => {
  it("pads the hour and reads 24 as the end of the day", () => {
    expect(hourLabel(0)).toBe("00:00");
    expect(hourLabel(6)).toBe("06:00");
    expect(hourLabel(24)).toBe("24:00");
  });
});

describe("GridTariffEditor — versions", () => {
  it("lists the versions newest first, with their bands and rates", () => {
    renderEditor();
    const items = versionItems();

    expect(items).toHaveLength(3);
    expect(text(items[0])).toContain("From Jan 1, 2027");
    expect(text(items[1])).toContain("From Jul 1, 2026");
    expect(text(items[2])).toContain("From Jan 1, 2026");

    expect(text(items[2])).toContain("00:00–06:00 → UGX 400/kWh");
    expect(text(items[2])).toContain("06:00–18:00 → UGX 550/kWh");
    expect(text(items[2])).toContain("18:00–24:00 → UGX 650/kWh");
    // A rate keeps its decimals although UGX amounts have none.
    expect(text(items[1])).toContain("00:00–24:00 → UGX 500.25/kWh");
  });

  it("marks the version in force today and the scheduled one", () => {
    renderEditor();
    const [scheduled, current, old] = versionItems();

    expect(text(scheduled)).toContain("Scheduled");
    expect(text(current)).toContain("In force");
    expect(text(old)).not.toMatch(/In force|Scheduled/);
  });

  it("shows the EmptyState with the add CTA when there are no versions", () => {
    renderEditor({ tariffs: [] });

    expect(screen.getByText("Add the grid tariff")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add the first version" })).toBeTruthy();
    // The header button belongs to the list at one or more versions.
    expect(screen.queryByRole("button", { name: "Add version" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Grid tariff versions" })).toBeNull();
  });

  it("hides the EmptyState while the form is open, and Cancel brings it back", () => {
    renderEditor({ tariffs: [] });
    fireEvent.click(screen.getByRole("button", { name: "+ Add the first version" }));

    expect(screen.getByRole("form", { name: "New grid tariff version" })).toBeTruthy();
    expect(screen.queryByText("Add the grid tariff")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New grid tariff version" })).toBeNull();
    expect(screen.getByText("Add the grid tariff")).toBeTruthy();
  });

  it("hides the Add version button while the form is open", () => {
    renderEditor();
    openForm();
    expect(screen.queryByRole("button", { name: "Add version" })).toBeNull();
  });

  it("is read-only without canManage", () => {
    renderEditor({ canManage: false });

    expect(screen.queryByRole("button", { name: "Add version" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete the version/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect((screen.getByLabelText("Count solar savings from") as HTMLInputElement).disabled).toBe(
      true
    );
    expect(screen.getByText("Ask a manager of this organization to change these settings.")).toBeTruthy();
  });

  it("shows no add CTA in the EmptyState without canManage", () => {
    renderEditor({ tariffs: [], canManage: false });

    expect(screen.queryByRole("button", { name: "+ Add the first version" })).toBeNull();
    expect(screen.getByText("Ask a manager of this organization to enter the grid tariff.")).toBeTruthy();
  });
});

describe("GridTariffEditor — add a version", () => {
  it("defaults to three bands, 00–06, 06–18 and 18–24, with empty rates", () => {
    renderEditor();
    openForm();

    const froms = [1, 2, 3].map((i) => (screen.getByLabelText(`Band ${i} from`) as HTMLSelectElement).value);
    const tos = [1, 2, 3].map((i) => (screen.getByLabelText(`Band ${i} to`) as HTMLSelectElement).value);
    const rates = [1, 2, 3].map((i) => (screen.getByLabelText(`Band ${i} rate`) as HTMLInputElement).value);

    expect(froms).toEqual(["0", "6", "18"]);
    expect(tos).toEqual(["6", "18", "24"]);
    expect(rates).toEqual(["", "", ""]);
    expect(screen.queryByLabelText("Band 4 rate")).toBeNull();
  });

  it("offers from-hours 00–23 and to-hours 01–24", () => {
    renderEditor();
    openForm();
    const from = screen.getByLabelText("Band 1 from") as HTMLSelectElement;
    const to = screen.getByLabelText("Band 1 to") as HTMLSelectElement;

    expect(Array.from(from.options).map((o) => o.value)).toEqual(
      Array.from({ length: 24 }, (_, h) => String(h))
    );
    expect(Array.from(to.options).map((o) => o.textContent)).toContain("24:00");
    expect(Array.from(to.options).map((o) => o.value)).not.toContain("0");
  });

  it("posts the effective date and the validated bands, then refreshes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "new" }));
    renderEditor();
    openForm();

    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["400", "550", "650.5"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/microgrids/${MICROGRID_ID}/grid-tariffs`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      effective_from: "2026-12-01",
      bands: [
        { from_hour: 0, to_hour: 6, rate: 400 },
        { from_hour: 6, to_hour: 18, rate: 550 },
        { from_hour: 18, to_hour: 24, rate: 650.5 },
      ],
    });
    // The form closes on success.
    expect(screen.queryByRole("form", { name: "New grid tariff version" })).toBeNull();
  });

  it("requires an effective date", async () => {
    renderEditor();
    openForm();
    setRates(["1", "2", "3"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Choose the date this version takes effect."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a date that already has a version", async () => {
    renderEditor();
    openForm();
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-07-01" } });
    setRates(["1", "2", "3"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/already takes effect on that date/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a rate on every band", async () => {
    renderEditor();
    openForm();
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["400", "", "650"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Enter a rate for every band.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a gap with validateGridTariffBands' message", async () => {
    renderEditor();
    openForm();
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["400", "550", "650"]);
    fireEvent.change(screen.getByLabelText("Band 3 from"), { target: { value: "19" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toBe("No band covers hour 18.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a negative rate", async () => {
    renderEditor();
    openForm();
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["400", "-1", "650"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Each band's rate must be a number of 0 or more."
    );
  });

  it("adds and removes bands", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, {}));
    renderEditor();
    openForm();

    fireEvent.click(screen.getByRole("button", { name: "Remove band 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove band 2" }));
    expect(screen.queryByLabelText("Band 2 rate")).toBeNull();
    // The last band cannot be removed.
    expect(screen.queryByRole("button", { name: "Remove band 1" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Band 1 to"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["500"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).bands).toEqual([
      { from_hour: 0, to_hour: 24, rate: 500 },
    ]);
  });

  it("shows the server's error and keeps the form open", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "A version already starts that day." }));
    renderEditor();
    openForm();
    fireEvent.change(screen.getByLabelText("Takes effect on"), { target: { value: "2026-12-01" } });
    setRates(["1", "2", "3"]);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    expect((await screen.findByRole("alert")).textContent).toBe("A version already starts that day.");
    expect(screen.getByRole("form", { name: "New grid tariff version" })).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("GridTariffEditor — delete a version", () => {
  it("confirms with a destructive dialog, deletes, then refreshes", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Delete the version from 2026-07-01" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete this grid tariff version?");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete version" }));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/microgrids/${MICROGRID_ID}/grid-tariffs/${CURRENT.id}`,
      { method: "DELETE" }
    );
  });

  it("shows the server's error in the dialog", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Not allowed." }));
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Delete the version from 2026-01-01" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete version" }));

    expect(await within(dialog).findByText("Not allowed.")).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("GridTariffEditor — savings settings", () => {
  it("shows the stored settings, efficiency as a percentage", () => {
    renderEditor();

    expect((screen.getByLabelText("Count solar savings from") as HTMLInputElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("Count arbitrage from") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Battery round-trip efficiency (%)") as HTMLInputElement).value).toBe("85");
  });

  it("defaults to 90% with no settings row", () => {
    renderEditor({ settings: null });
    expect((screen.getByLabelText("Battery round-trip efficiency (%)") as HTMLInputElement).value).toBe("90");
  });

  it("puts the settings, with empty dates as null and efficiency as a fraction", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Count solar savings from"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Count arbitrage from"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Battery round-trip efficiency (%)"), {
      target: { value: "92.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/microgrids/${MICROGRID_ID}/savings-settings`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      solar_savings_from: null,
      arbitrage_from: "2026-11-01",
      round_trip_efficiency: 0.925,
    });
    expect(screen.getByText("Savings settings saved.")).toBeTruthy();
  });

  it.each([["0"], ["-5"], ["100.1"], [""]])("rejects an efficiency of %j", async (value) => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Battery round-trip efficiency (%)"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/more than 0% and at most 100%/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts 100%", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    renderEditor();
    fireEvent.change(screen.getByLabelText("Battery round-trip efficiency (%)"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).round_trip_efficiency).toBe(1);
  });

  it("shows the server's error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "Bad date." }));
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Bad date.");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the savings settings.");
  });
});

describe("GridTariffEditor — design tokens", () => {
  it("uses token classes only", () => {
    const { container } = renderEditor();
    openForm();
    expect(container.innerHTML).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc|amber)-\d/);
  });
});
