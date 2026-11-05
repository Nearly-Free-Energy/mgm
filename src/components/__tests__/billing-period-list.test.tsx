// BillingPeriodList unit tests
//
// Strategy:
//   - Mount BillingPeriodList with fixture periods wrapped in
//     <LocaleProvider locale="en-UG" currency="UGX">.
//   - Assert:
//     (a) PeriodPicker trigger button is rendered (aria-haspopup="listbox").
//     (b) Selecting an option calls router.push with the correct URL.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { LocaleProvider } from "../format/locale-context";
import type { BillingPeriod } from "@/lib/types/domain";

// Mock next/navigation BEFORE any component imports that use it
const pushSpy = vi.fn();
const refreshSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/microgrids/mg-1/billing",
}));

// Result of `from("billing_periods").delete().eq(...)`; the delete-period
// tests override it per case.
const deleteEqMock = vi.fn(
  (): Promise<{ error: { code?: string; message: string; details?: string } | null }> =>
    Promise.resolve({ error: null }),
);

// Mock Supabase client (BillingPeriodList calls createClient() on render)
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({ eq: () => deleteEqMock() }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: "new-period" }, error: null }),
        }),
      }),
    }),
  }),
}));

// Import after mocks are set up
import { BillingPeriodList, getDefaultDates } from "../BillingPeriodList";

// ─── Fixture data ────────────────────────────────────────────────────────────

const MICROGRID_ID = "mg-fixture-1";

const PERIOD_1: BillingPeriod = {
  id: "period-a",
  microgrid_id: MICROGRID_ID,
  start_date: "2026-02-01",
  end_date: "2026-02-28",
  status: "closed",
  created_at: "2026-02-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
  timezone: "UTC",
  rate_schedule_id: null,
};

const PERIOD_2: BillingPeriod = {
  id: "period-b",
  microgrid_id: MICROGRID_ID,
  start_date: "2026-03-01",
  end_date: "2026-03-31",
  status: "draft",
  created_at: "2026-03-01T00:00:00Z",
  closed_at: null,
  timezone: "UTC",
  rate_schedule_id: null,
};

const SUMMARIES = {
  "period-a": { totalKwh: 120, totalAmount: 60000 },
  "period-b": { totalKwh: 45, totalAmount: 22500 },
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("BillingPeriodList", () => {
  beforeEach(() => {
    pushSpy.mockClear();
  });

  it("(a) renders the PeriodPicker trigger button with aria-haspopup='listbox'", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );

    const trigger = document.querySelector("button[aria-haspopup='listbox']");
    expect(trigger).not.toBeNull();
  });

  it("(b) selecting the second option calls router.push with the correct URL", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );

    // Open the picker by clicking the trigger
    const trigger = document.querySelector(
      "button[aria-haspopup='listbox']",
    ) as HTMLButtonElement;
    fireEvent.click(trigger);

    // All period options are role="option" buttons inside the panel
    const options = screen.getAllByRole("option");
    // The picker renders periods in the same order as passed (server returns DESC by start_date)
    // PERIOD_1 is index 0, PERIOD_2 is index 1
    expect(options.length).toBeGreaterThanOrEqual(2);

    // Click the second option (PERIOD_2)
    fireEvent.click(options[1]);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(
      `/microgrids/${MICROGRID_ID}/billing/${PERIOD_2.id}`,
    );
  });
});

// ─── EmptyState (#139 P9) ─────────────────────────────────────────────────────

describe("BillingPeriodList — EmptyState (#139)", () => {
  it("shows EmptyState title and body when periods is empty", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
        />
      </Wrapper>
    );
    expect(screen.getByText("Create the first billing period")).toBeTruthy();
    expect(screen.getByText(/A billing period defines the start and end dates/)).toBeTruthy();
  });

  it("shows '+ Create period' CTA when canManage=true and periods empty", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
    expect(screen.getByRole("button", { name: /Create period/i })).toBeTruthy();
  });

  it("hides CTA and shows role-locked footnote when canManage=false", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={false}
        />
      </Wrapper>
    );
    expect(screen.queryByRole("button", { name: /Create period/i })).toBeNull();
    expect(
      screen.getByText(/Ask a super admin to create the first billing period/)
    ).toBeTruthy();
  });

  it("shows canManage=true footnote about editing date range", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
    expect(
      screen.getByText(/You'll be able to edit the date range/)
    ).toBeTruthy();
  });

  it("does NOT show EmptyState when periods are present", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );
    expect(screen.queryByText("Create the first billing period")).toBeNull();
  });
});

// ─── CTA collapse / picker invariant (#171) ──────────────────────────────────
//
// One CTA at zero, one CTA at >=1, no overlap. Mirrors AC-7 of the ticket.

describe("BillingPeriodList — CTA collapse (#171)", () => {
  beforeEach(() => {
    pushSpy.mockClear();
  });

  it("at zero periods + form closed: PeriodPicker NOT rendered, EmptyState rendered with one CTA, form NOT rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Picker hidden — its trigger has aria-haspopup="listbox"
    expect(document.querySelector("button[aria-haspopup='listbox']")).toBeNull();

    // EmptyState rendered with the canonical first-run title
    expect(screen.getByText("Create the first billing period")).toBeTruthy();

    // Exactly one CTA: the EmptyState's "+ Create period" button
    const createButtons = screen.getAllByRole("button", { name: /Create period/i });
    expect(createButtons).toHaveLength(1);

    // Form not rendered — there's no Cancel button visible
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).toBeNull();
  });

  it("at zero periods + clicking EmptyState CTA: form rendered, EmptyState NOT rendered, PeriodPicker still NOT rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Click the EmptyState CTA to open the form
    fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));

    // Form is rendered — Cancel + Create Period buttons visible
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Period/i })).toBeTruthy();

    // EmptyState gone — its title no longer in the document
    expect(screen.queryByText("Create the first billing period")).toBeNull();

    // Picker still hidden — periods.length is still 0
    expect(document.querySelector("button[aria-haspopup='listbox']")).toBeNull();
  });

  it("at zero periods + form open + clicking Cancel: form NOT rendered, EmptyState rendered with CTA", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Open the form
    fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    // Form gone — Cancel button no longer visible
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).toBeNull();

    // EmptyState back with its "+ Create period" CTA
    expect(screen.getByText("Create the first billing period")).toBeTruthy();
    expect(screen.getByRole("button", { name: /\+ Create period/i })).toBeTruthy();
  });

  it("at >=1 period + form closed: PeriodPicker rendered, EmptyState NOT rendered, list rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Picker rendered
    expect(document.querySelector("button[aria-haspopup='listbox']")).not.toBeNull();

    // EmptyState absent
    expect(screen.queryByText("Create the first billing period")).toBeNull();

    // List rendered — column headers present
    expect(screen.getByText(/Date Range/i)).toBeTruthy();
  });

  it("at >=1 period + clicking picker '+ New period': form rendered, picker still rendered, list still rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Open the picker
    const trigger = document.querySelector(
      "button[aria-haspopup='listbox']",
    ) as HTMLButtonElement;
    fireEvent.click(trigger);

    // Click the picker's "+ New period" header CTA
    fireEvent.click(screen.getByRole("button", { name: /\+ New period/i }));

    // Form is rendered — Cancel + Create Period buttons visible
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Period/i })).toBeTruthy();

    // Picker still rendered
    expect(document.querySelector("button[aria-haspopup='listbox']")).not.toBeNull();

    // List still rendered — column header still in DOM
    expect(screen.getByText(/Date Range/i)).toBeTruthy();
  });
});

describe("BillingPeriodList — create via capability API (issue #5, review P1)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    pushSpy.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function openForm() {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));
  }

  it("submitting the form POSTs to /api/billing-periods and navigates to the new period", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ period: { id: "new-period" } }),
    });
    openForm();

    fireEvent.click(screen.getByRole("button", { name: /^Create Period$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/billing-periods");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.microgrid_id).toBe(MICROGRID_ID);
    expect(body.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith(
        `/microgrids/${MICROGRID_ID}/billing/new-period`
      )
    );
  });

  it("surfaces 409 billing_disabled in the banner and does not navigate", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: "billing_disabled",
        error: "Billing is disabled for this organization.",
      }),
    });
    openForm();

    fireEvent.click(screen.getByRole("button", { name: /^Create Period$/i }));

    await waitFor(() =>
      expect(
        screen.getByText("Billing is disabled for this organization.")
      ).toBeTruthy()
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("getDefaultDates — previous calendar month", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("names the microgrid's previous month in Africa/Kampala (UTC+3)", () => {
    // 00:30 on 1 November in Kampala is still 31 October in UTC.
    const now = new Date("2026-11-01T00:30:00+03:00");
    expect(getDefaultDates(now, "Africa/Kampala")).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
  });

  it("names the microgrid's previous month in America/New_York (UTC-4)", () => {
    // 22:00 on 31 October in New York is already 1 November in UTC.
    const now = new Date("2026-10-31T22:00:00-04:00");
    expect(getDefaultDates(now, "America/New_York")).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
    });
  });

  it("rolls January back to December of the previous year in both zones", () => {
    const kampala = new Date("2026-01-01T00:30:00+03:00");
    expect(getDefaultDates(kampala, "Africa/Kampala")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
    const newYork = new Date("2026-01-15T12:00:00-05:00");
    expect(getDefaultDates(newYork, "America/New_York")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
    // 02:00 UTC on 1 January is still 31 December in New York.
    const newYorkEve = new Date("2026-01-01T02:00:00Z");
    expect(getDefaultDates(newYorkEve, "America/New_York")).toEqual({
      start: "2025-11-01",
      end: "2025-11-30",
    });
  });

  it("ends a leap-year February on the 29th", () => {
    const now = new Date("2028-03-10T12:00:00+03:00");
    expect(getDefaultDates(now, "Africa/Kampala")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("uses the browser's local calendar when no timezone is given", () => {
    process.env.TZ = "Africa/Kampala";
    expect(getDefaultDates(new Date("2026-11-15T09:00:00+03:00"))).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
    process.env.TZ = "America/New_York";
    expect(getDefaultDates(new Date("2026-01-15T09:00:00-05:00"))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("falls back to the local calendar when the timezone id is unknown", () => {
    process.env.TZ = "Africa/Kampala";
    expect(
      getDefaultDates(new Date("2026-11-15T09:00:00+03:00"), "Not/A_Zone"),
    ).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("pre-fills the create form with the microgrid's previous month", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T00:30:00+03:00"));
    try {
      render(
        <Wrapper>
          <BillingPeriodList
            microgridId={MICROGRID_ID}
            periods={[]}
            summaries={{}}
            currency="UGX"
            timezone="Africa/Kampala"
            canManage={true}
          />
        </Wrapper>
      );
      fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));
      const values = Array.from(
        document.querySelectorAll<HTMLInputElement>("input[type='date']")
      ).map((input) => input.value);
      expect(values).toEqual(["2026-10-01", "2026-10-31"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BillingPeriodList — delete period", () => {
  beforeEach(() => {
    refreshSpy.mockClear();
    deleteEqMock.mockReset();
    deleteEqMock.mockResolvedValue({ error: null });
  });

  function renderList(periods: BillingPeriod[]) {
    return render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={periods}
          summaries={SUMMARIES}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
  }

  function confirmDelete() {
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  }

  it("offers Delete only on the draft period's row", () => {
    renderList([PERIOD_1, PERIOD_2]);
    const buttons = screen.getAllByRole("button", { name: /^Delete$/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].closest("tr")?.textContent).toMatch(/draft/i);
  });

  it("offers no Delete when every period is closed", () => {
    renderList([PERIOD_1]);
    expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
  });

  it("the confirm dialog says what the delete removes", () => {
    renderList([PERIOD_2]);
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(
      screen.getByText(
        /removes the draft period, its generated bills and its history entries/i,
      ),
    ).toBeTruthy();
  });

  it("refreshes the list after a successful delete", async () => {
    renderList([PERIOD_2]);
    confirmDelete();
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
  });

  it("explains a delete refused because the period has recorded payments", async () => {
    deleteEqMock.mockResolvedValue({
      error: {
        code: "23514",
        message: "billing_period_kept: a billing period with recorded payments cannot be deleted",
        details: "payment_activity",
      },
    });
    renderList([PERIOD_2]);
    confirmDelete();
    await waitFor(() =>
      expect(screen.getByText(/has recorded payments, so it is kept/i)).toBeTruthy(),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("explains a delete refused because the period was closed meanwhile", async () => {
    deleteEqMock.mockResolvedValue({
      error: {
        code: "23514",
        message: "billing_period_kept: a closed billing period cannot be deleted",
        details: "closed",
      },
    });
    renderList([PERIOD_2]);
    confirmDelete();
    await waitFor(() =>
      expect(screen.getByText(/is closed, so it is kept as the billing record/i)).toBeTruthy(),
    );
  });
});
