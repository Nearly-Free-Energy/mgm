// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { LocaleProvider } from "@/components/format/locale-context";
import { SavingsTable } from "../savings-table";
import type { SavingsColumn, SavingsSummary } from "@/lib/billing/site-savings";

const DATE = "2026-11-06";

function col(overrides: Partial<SavingsColumn> = {}): SavingsColumn {
  return {
    solarSavings: 660,
    arbitrageGain: 140,
    total: 800,
    lightsOnPct: 99.5,
    days: 1,
    ...overrides,
  };
}

function summary(overrides: Partial<SavingsSummary> = {}): SavingsSummary {
  return {
    columns: {
      day: col(),
      month: col({ solarSavings: 3960, arbitrageGain: 840, total: 4800, lightsOnPct: 98.25, days: 6 }),
      sinceStart: col({
        solarSavings: 20460,
        arbitrageGain: 4340,
        total: 24800,
        lightsOnPct: 97,
        days: 31,
      }),
    },
    sinceStartDate: "2026-10-07",
    missingTariffDays: 0,
    ...overrides,
  };
}

type Props = React.ComponentProps<typeof SavingsTable>;

function renderTable(props: Partial<Props> = {}) {
  return render(
    <LocaleProvider locale="en-UG" currency="UGX">
      <SavingsTable
        summary={summary()}
        date={DATE}
        solarFrom="2026-10-07"
        arbitrageFrom="2026-10-20"
        {...props}
      />
    </LocaleProvider>
  );
}

/** Cell texts with Intl's no-break spaces made plain. */
function cells(tr: HTMLElement): string[] {
  return within(tr)
    .getAllByRole("cell")
    .map((c) => (c.textContent ?? "").replace(/\u00a0/g, " "));
}

function row(name: RegExp) {
  return screen.getByRole("rowheader", { name }).closest("tr")!;
}

describe("SavingsTable", () => {
  it("labels the columns with the day, the month so far and since start", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);

    expect(headers[1]).toBe("6 Nov");
    expect(headers[2]).toBe("November so far");
    expect(headers[3]).toBe("Since startfrom 7 Oct 2026");
  });

  it("shows each row's figures in the microgrid currency", () => {
    renderTable();

    const solar = cells(row(/Solar savings/));
    expect(solar).toEqual(["USh 660", "USh 3,960", "USh 20,460"]);

    const arbitrage = cells(row(/Arbitrage gain/));
    expect(arbitrage).toEqual(["USh 140", "USh 840", "USh 4,340"]);

    const total = cells(row(/Total saved/));
    expect(total).toEqual(["USh 800", "USh 4,800", "USh 24,800"]);
  });

  it("uses the currency from the locale context", () => {
    render(
      <LocaleProvider locale="en-US" currency="USD">
        <SavingsTable summary={summary()} date={DATE} solarFrom="2026-10-07" arbitrageFrom={null} />
      </LocaleProvider>
    );
    expect(within(row(/Total saved/)).getAllByRole("cell")[0].textContent).toBe("$800.00");
  });

  it("shows lights on as a percentage with one decimal", () => {
    renderTable();
    const cells = within(row(/Lights on/)).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["99.5%", "98.3%", "97.0%"]);
  });

  it("marks the total row bold", () => {
    renderTable();
    expect(row(/Total saved/).querySelector("th")!.className).toContain("font-semibold");
    expect(row(/Solar savings/).querySelector("th")!.className).not.toContain("font-semibold");
  });

  it("says how solar is valued and since when each saving counts", () => {
    renderTable();

    expect(
      screen.getByText("valued at the grid rate of each hour, since 7 Oct 2026")
    ).toBeTruthy();
    expect(screen.getByText("since 20 Oct 2026")).toBeTruthy();
  });

  it("says a saving is not counted when it has no start date", () => {
    renderTable({
      arbitrageFrom: null,
      summary: summary({
        columns: {
          day: col({ arbitrageGain: null, total: 660 }),
          month: col({ arbitrageGain: null }),
          sinceStart: col({ arbitrageGain: null }),
        },
      }),
    });

    expect(within(row(/Arbitrage gain/)).getByText("not counted: no start date set")).toBeTruthy();
    expect(cells(row(/Arbitrage gain/))).toEqual([
      "—",
      "—",
      "—",
    ]);
  });

  it("shows a dash for figures that could not be worked out", () => {
    renderTable({
      summary: summary({
        columns: {
          day: col({ solarSavings: null, arbitrageGain: null, total: null, lightsOnPct: null }),
          month: col(),
          sinceStart: col(),
        },
      }),
    });

    for (const name of [/Solar savings/, /Arbitrage gain/, /Total saved/, /Lights on/]) {
      expect(within(row(name)).getAllByRole("cell")[0].textContent).toBe("—");
    }
  });

  it("leaves the since-start date out when there is none", () => {
    renderTable({ summary: summary({ sinceStartDate: null }) });
    expect(screen.getAllByRole("columnheader")[3].textContent).toBe("Since start");
  });

  it("says how many days had no tariff", () => {
    const { unmount } = renderTable({ summary: summary({ missingTariffDays: 3 }) });
    expect(
      screen.getByText(/3 days had no grid tariff in force and are left out of the money figures/)
    ).toBeTruthy();
    unmount();

    renderTable({ summary: summary({ missingTariffDays: 1 }) });
    expect(
      screen.getByText(/1 day had no grid tariff in force and is left out of the money figures/)
    ).toBeTruthy();
  });

  it("does not mention missing tariffs or capping when neither applies", () => {
    renderTable();
    expect(screen.queryByText(/had no grid tariff/)).toBeNull();
    expect(screen.queryByText(/at most a year/)).toBeNull();
  });

  it("says when the since-start range was cut to a year", () => {
    renderTable({ cappedFrom: "2025-11-06" });
    expect(
      screen.getByText(/Since start covers at most a year: days before 6 Nov 2025 are not read/)
    ).toBeTruthy();
  });

  it("explains the definitions in a footnote", () => {
    renderTable();
    const text = document.body.textContent ?? "";

    expect(text).toContain("priced at what the grid would have charged for it at that hour.");
    expect(text).toContain("Power the battery gave during a cut is backup and is not counted.");
    expect(text).toContain("total is the figure to rely on");
    expect(text).not.toContain("estimated from the load");
  });

  it("says solar is estimated when it is", () => {
    renderTable({ solarEstimated: true });
    expect(document.body.textContent).toContain(
      "(solar is estimated from the load, grid and battery where there is no solar meter)."
    );
  });

  it("formats calendar days without shifting them by the viewer's timezone", () => {
    // 1 Jan at UTC midnight is still 31 Dec west of Greenwich; the keys are
    // formatted in UTC so the label is the stored day.
    renderTable({ date: "2027-01-01", solarFrom: "2027-01-01" });
    expect(screen.getAllByRole("columnheader")[1].textContent).toBe("1 Jan");
    expect(screen.getAllByRole("columnheader")[2].textContent).toBe("January so far");
  });

  it("uses token classes only", () => {
    const html = renderToStaticMarkup(
      <SavingsTable
        summary={summary({ missingTariffDays: 2 })}
        date={DATE}
        solarFrom="2026-10-07"
        arbitrageFrom="2026-10-20"
        cappedFrom="2025-11-06"
      />
    );
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc|amber)-\d/);
  });
});
