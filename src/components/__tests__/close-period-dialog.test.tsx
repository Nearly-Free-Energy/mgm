/**
 * ClosePeriodDialog (#201): the legacy page's close, through the host's
 * confirmation step. The dialog fetches the review (the close route's 428
 * with its ceremony), renders ConfirmStep, and sends exactly the digest of
 * that review with the acknowledgements ticked and the name typed.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ceremony } from "@/lib/gui/contract";
import { ClosePeriodDialog, type CloseAnswer } from "../ui/close-period-dialog";

// jsdom creates only untrusted events, so the positive paths stand in for
// real input, as in the ConfirmStep tests. A test that sets this false shows
// script input refused.
const input = vi.hoisted(() => ({ trusted: true }));
vi.mock("@/lib/gui/host/client/trusted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gui/host/client/trusted")>()),
  isTrusted: () => input.trusted,
  hasUserActivation: () => true,
}));

beforeEach(() => {
  input.trusted = true;
});
afterEach(() => vi.restoreAllMocks());

const PERIOD = "770e8400-e29b-41d4-a716-446655440000";

function ceremony(change: Partial<Ceremony> = {}): Ceremony {
  return {
    type: "ceremony",
    statement: "Close October 2026. Bills become final, and corrections after this are recorded against the closed period.",
    facts: [
      { label: "Bills", value: { t: "number", v: 12, text: "12" } },
      { label: "Total", value: { t: "money", v: 4216800, currency: "UGX", text: "UGX 4,216,800" } },
    ],
    warnings: ["1 bill has no usage recorded: House 7."],
    acknowledgements: [
      { id: "totals_reviewed", label: "I have reviewed these totals, and they are what I will file. Closing is final." },
      { id: "bills_without_usage", label: "I am closing this period although some bills have no usage recorded." },
    ],
    typed: "October 2026",
    digest: "v1:first",
    ...change,
  };
}

const review = (c: Ceremony = ceremony()): CloseAnswer => ({
  ok: false,
  status: 428,
  code: "billing_close_confirmation_required",
  ceremony: c,
});
const closed: CloseAnswer = { ok: true, status: 200 };

function mount(answers: CloseAnswer[], props: { open?: boolean } = {}) {
  const queue = [...answers];
  const post = vi.fn<(periodId: string, body: unknown) => Promise<CloseAnswer>>(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no answer queued");
    return next;
  });
  const onOpenChange = vi.fn();
  const onClosed = vi.fn();
  const onExportCsv = vi.fn();
  const view = render(
    <ClosePeriodDialog
      open={props.open ?? true}
      onOpenChange={onOpenChange}
      periodId={PERIOD}
      onClosed={onClosed}
      onExportCsv={onExportCsv}
      post={post}
    />
  );
  return { post, onOpenChange, onClosed, onExportCsv, view, queue };
}

const confirmButton = () => screen.getByRole("button", { name: "Close period" }) as HTMLButtonElement;
const typedBox = () => screen.getByRole("textbox") as HTMLInputElement;

function confirmAll(name = "October 2026") {
  for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
  fireEvent.change(typedBox(), { target: { value: name } });
}

describe("ClosePeriodDialog — the review", () => {
  it("fetches the review on open and shows the host's step: totals, warnings, acknowledgements, the name to type", async () => {
    const { post } = mount([review()]);
    expect(screen.getByRole("status").textContent).toMatch(/Loading the period/);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    expect(post).toHaveBeenCalledWith(PERIOD, {});
    expect(screen.getByText("UGX 4,216,800")).toBeTruthy();
    expect(screen.getByText("1 bill has no usage recorded: House 7.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText(/to confirm/).textContent).toContain("October 2026");
    expect(confirmButton().disabled).toBe(true);
  });

  it("enables Close period only once every acknowledgement is ticked and the name is typed", async () => {
    mount([review()]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    const [first, second] = screen.getAllByRole("checkbox");
    fireEvent.click(first);
    fireEvent.change(typedBox(), { target: { value: "October 2026" } });
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(second);
    expect(confirmButton().disabled).toBe(false);
  });

  it("ignores ticks and typing that are not real input", async () => {
    mount([review()]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    input.trusted = false;
    confirmAll();
    expect(confirmButton().disabled).toBe(true);
  });

  it("is neutral, not destructive, and puts Cancel first", async () => {
    mount([review()]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    expect(confirmButton().className).toContain("bg-primary");
    expect(confirmButton().className).not.toContain("bg-destructive");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
  });
});

describe("ClosePeriodDialog — closing", () => {
  it("sends the review's digest with what was ticked and typed, then shows the closed state", async () => {
    const { post, onClosed, onExportCsv } = mount([review(), closed]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    confirmAll("October 2026");
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Closed: October 2026" });
    expect(post).toHaveBeenLastCalledWith(PERIOD, {
      confirmation: {
        digest: "v1:first",
        acknowledged: ["totals_reviewed", "bills_without_usage"],
        typed: "October 2026",
      },
    });
    expect(onClosed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV for URA" }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it("when the totals changed, shows the new review with nothing ticked, and sends its digest next", async () => {
    const changed = ceremony({ digest: "v1:second", facts: [{ label: "Bills", value: { t: "number", v: 13, text: "13" } }] });
    const { post } = mount([
      review(),
      { ok: false, status: 409, code: "billing_period_totals_changed", ceremony: changed },
      closed,
    ]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    confirmAll();
    fireEvent.click(confirmButton());
    await screen.findByText(/The totals changed after you reviewed them/);
    expect(screen.getByText("13")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(false);
    expect(typedBox().value).toBe("");
    expect(confirmButton().disabled).toBe(true);

    confirmAll();
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Closed: October 2026" });
    expect((post.mock.calls[2][1] as { confirmation: { digest: string } }).confirmation.digest).toBe("v1:second");
  });

  it("stays open while the close is sending, and reports a close that went through", async () => {
    let finish: (answer: CloseAnswer) => void = () => {};
    const { post, onOpenChange, onClosed } = mount([review()]);
    post.mockImplementationOnce(() => new Promise<CloseAnswer>((resolve) => (finish = resolve)));
    await screen.findByRole("heading", { name: "Close October 2026?" });
    confirmAll();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await act(async () => finish({ ok: true, status: 200 }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    await screen.findByRole("heading", { name: "Closed: October 2026" });
  });

  it("reports a close that went through even if the dialog was closed meanwhile", async () => {
    let finish: (answer: CloseAnswer) => void = () => {};
    const { post, onClosed, view } = mount([review()]);
    post.mockImplementationOnce(() => new Promise<CloseAnswer>((resolve) => (finish = resolve)));
    await screen.findByRole("heading", { name: "Close October 2026?" });
    confirmAll();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    // The page closes it, for example by navigating away.
    view.rerender(
      <ClosePeriodDialog open={false} onOpenChange={vi.fn()} periodId={PERIOD} onClosed={onClosed} post={post} />
    );
    await act(async () => finish({ ok: true, status: 200 }));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and stays on the step", async () => {
    const { onClosed } = mount([
      review(),
      { ok: false, status: 428, code: "billing_close_name_mismatch", message: "Type the period's name, October 2026, to close it." },
    ]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    confirmAll();
    fireEvent.click(confirmButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Type the period's name, October 2026, to close it.");
    expect(confirmButton()).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe("ClosePeriodDialog — when the period cannot close", () => {
  it("shows why when a bill total is not a whole number, with the totals and nothing to confirm", async () => {
    mount([
      {
        ok: false,
        status: 409,
        code: "billing_close_fractional_totals",
        message: "Regenerate the bills for House 2 before closing: their totals are not whole numbers.",
        ceremony: ceremony(),
      },
    ]);
    expect((await screen.findByRole("alert")).textContent).toContain("Regenerate the bills for House 2");
    expect(screen.getByText("UGX 4,216,800")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close period" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("offers Retry when the review cannot be loaded, and loads it again", async () => {
    const { post } = mount([{ ok: false, status: 503, code: "billing_review_unavailable", message: "Retry." }, review()]);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the period's totals.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Close October 2026?" });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("asks the server again each time it opens", async () => {
    const { post, view } = mount([review(), review(ceremony({ digest: "v1:again" }))]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    view.rerender(
      <ClosePeriodDialog open={false} onOpenChange={vi.fn()} periodId={PERIOD} onClosed={vi.fn()} post={post} />
    );
    view.rerender(<ClosePeriodDialog open onOpenChange={vi.fn()} periodId={PERIOD} onClosed={vi.fn()} post={post} />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Close October 2026?" });
  });

  it("Cancel closes the dialog", async () => {
    const { onOpenChange } = mount([review()]);
    await screen.findByRole("heading", { name: "Close October 2026?" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
