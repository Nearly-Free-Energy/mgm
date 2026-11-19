/**
 * Gridtop's renderer for `billing.send-queue@1`: when Gridtop picks it, the
 * cards with each bill's link as text, never an anchor, what Copy link
 * writes and announces, the readiness note, the empty state, and the
 * fallback to the kit's view. The models are written by hand, following
 * buildSendQueueModel (src/lib/billing/surface/send-queue-model.ts): a GUI's
 * tests import no capability (gui-boundary.test.ts), so the view's own
 * examples are drawn by src/lib/gui/__tests__/view-examples.test.tsx.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelView, checkModel, loadLazyRenderers, renderInKit, withPoke, type Recorded } from "@/lib/gui/conformance";
import type { ActionRef, Column, Json, LinkRef, ModelOf, RowOf, Value, ViewModel } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { GridtopGui } from "../../..";
import { GRIDTOP_RENDERERS, drawnBespoke } from "../..";
import { readSendQueueExt } from "../ext";
import SendQueueView, { REPEAT, copiedMessage, copyFailedMessage } from "../view";

const MG = "00000000-0000-4000-8000-0000000000a1";
const PERIOD = "00000000-0000-4000-8000-0000000000b2";
const ORIGIN = "https://mgm.example.org";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const billId = (i: number) => id(0xd1 + i);
const tenantId = (i: number) => id(0xc1 + i);
const urlOf = (i: number) => `${ORIGIN}/api/billing-line-items/${billId(i)}/pay`;

const TENANTS = ["Aisha M.", "Brian K.", "Carol N."] as const;
const BACK: LinkRef = { id: "billing.back-to-period", label: "Back to period", href: `/microgrids/${MG}/billing/${PERIOD}` };
const HISTORY: LinkRef = { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history` };
const NOT_SET_UP = "No payment provider is configured. Ask a super admin to configure Payment for this community.";
const PAID_NOTE = "Paid: no link to send.";
const BILLING_OFF = "Billing is disabled for this organization. Enable it in Settings → Plugins.";

const COLUMNS: Column[] = [
  { key: "tenant", label: "Tenant", type: "ref", priority: 1 },
  { key: "total", label: "Total", type: "money", priority: 1 },
  { key: "payment", label: "Payment", type: "status", priority: 1 },
  { key: "link", label: "Payment link", type: "text", priority: 1 },
  { key: "note", label: "Note", type: "text", priority: 2 },
];
const EMPTY: Value = { t: "empty", text: "—" };
const pdf = (i: number): LinkRef => ({
  id: "billing.download-bill",
  label: "Download bill (PDF)",
  icon: "download",
  href: `/api/billing-line-items/${billId(i)}/pdf`,
  download: { mime: "application/pdf", filename: `bill-${billId(i)}.pdf` },
});

/** Bill i: its total, payment status and note, and its link when `linked`. */
function row(i: number, o: { total: [number, string]; status: [string, "neutral" | "success" | "warning", string]; linked: boolean; note?: string }): RowOf<ActionRef> {
  const tenant = { kind: "tenant" as const, id: tenantId(i), label: TENANTS[i], href: `/microgrids/${MG}/setup/tenants/${tenantId(i)}` as const };
  return {
    id: billId(i),
    entity: { kind: "lineItem", id: billId(i), label: TENANTS[i] },
    related: [tenant],
    cells: {
      tenant: { t: "ref", ref: tenant, text: TENANTS[i] },
      total: { t: "money", v: o.total[0], currency: "UGX", text: o.total[1] },
      payment: { t: "status", v: o.status[0], tone: o.status[1], text: o.status[2] },
      link: o.linked ? { t: "text", text: urlOf(i) } : EMPTY,
      note: o.note ? { t: "text", text: o.note } : EMPTY,
    },
    actions: [],
    links: [pdf(i)],
  };
}

const ROWS = [
  row(0, { total: [55875, "UGX 55,875"], status: ["unpaid", "neutral", "Unpaid"], linked: true }),
  row(1, { total: [24000, "UGX 24,000"], status: ["link_generated", "warning", "Link sent"], linked: true }),
  row(2, { total: [31250, "UGX 31,250"], status: ["paid", "success", "Paid"], linked: false, note: PAID_NOTE }),
];

function model(o: { rows?: RowOf<ActionRef>[]; urls?: (string | null)[]; note?: Json; empty?: ModelOf<"collection">["body"]["empty"] } & Partial<Omit<ModelOf<"collection">, "body">> = {}): ModelOf<"collection"> {
  const { rows = ROWS, urls, note = null, empty, ...rest } = o;
  return {
    type: "view",
    view: "billing.send-queue",
    kind: "collection",
    title: "Send November 2026 bills",
    subtitle: "Africa/Kampala",
    org: "00000000-0000-4000-8000-0000000000a0",
    entity: { kind: "billingPeriod", id: PERIOD, label: "1 Nov 2026 – 30 Nov 2026" },
    trail: [{ label: "Example site", href: `/microgrids/${MG}` }],
    actions: [],
    links: [BACK, HISTORY],
    attached: [],
    live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    body: { columns: COLUMNS, rows, empty: empty ?? { title: "No bills to send yet.", text: "Generate this period's bills on the period page first." } },
    ext: {
      schema: "billing.send-queue@1",
      data: { rows: rows.map((r, n) => ({ id: r.id, url: urls ? urls[n] : r.cells.link.t === "text" ? r.cells.link.text : null })), note } as unknown as Json,
    },
    ...rest,
  };
}
const unconfigured = () =>
  model({
    rows: ROWS.map((r) => ({ ...r, cells: { ...r.cells, link: EMPTY } })),
    subtitle: "No payment provider",
    note: { tone: "warning", text: NOT_SET_UP },
  });
const noBills = () => model({ rows: [] });
const billingOff = () => ({ ...model(), notice: { tone: "warning" as const, text: BILLING_OFF } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function draw(m: ViewModel): Promise<Recorded> {
  const rendered = await renderInKit(<SendQueueView model={m} kit={kit} />);
  unmount = rendered.unmount;
  return rendered.log;
}
const said = () => (document.querySelector("[aria-live='polite']")?.textContent ?? "").replace(new RegExp(`${REPEAT}$`), "");
const clipboard = (fail = false) => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
    if (fail) throw new Error("denied");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};
const cards = () => within(screen.getByRole("list", { name: "Bills to send" })).getAllByRole("listitem").filter((li) => li.parentElement?.getAttribute("aria-label") === "Bills to send");

describe("Gridtop's send-queue renderer: choosing it", () => {
  it("is registered for version 1, and leaves the page's controls to the window bar", () => {
    expect(GRIDTOP_RENDERERS["billing.send-queue"].reads).toEqual([1]);
    expect(drawnBespoke(model())).toBe(false);
  });

  it("draws version 1 itself, once its chunk loads, and leaves @2 or no ext to the kit's view", async () => {
    unmount = (await renderInKit(<ModelView gui={GridtopGui} model={model()} />)).unmount;
    await waitFor(() => expect(document.querySelector("[data-send-queue]")).not.toBeNull());
    unmount();
    for (const m of [{ ...model(), ext: { schema: "billing.send-queue@2" as const, data: model().ext!.data } }, { ...model(), ext: undefined }]) {
      unmount = (await renderInKit(<ModelView gui={GridtopGui} model={m} />)).unmount;
      expect(document.querySelector("[data-send-queue]")).toBeNull();
      expect(document.querySelector("[data-gui-kind='collection']")).not.toBeNull();
      unmount();
    }
    unmount = null;
  });

  it("reads the links and note as the server sends them", () => {
    expect(readSendQueueExt(model())).toEqual({ urls: [urlOf(0), urlOf(1), null], note: null });
    expect(readSendQueueExt(unconfigured())).toEqual({ urls: [null, null, null], note: { tone: "warning", text: NOT_SET_UP } });
    expect(readSendQueueExt(noBills())).toEqual({ urls: [], note: null });
  });

  it.each([
    ["rows that do not line up", model({ urls: [urlOf(0), urlOf(1)] })],
    ["a url the link cell does not show", model({ urls: [urlOf(1), urlOf(1), null] })],
    ["a link cell with no url", model({ urls: [null, urlOf(1), null] })],
    ["a url that is not http", model({ urls: ["javascript:alert(1)", urlOf(1), null] })],
    ["a note of another tone", model({ note: { tone: "danger", text: "x" } })],
  ])("draws the kit's view for %s", async (_label, m) => {
    expect(readSendQueueExt(m)).toBeNull();
    await draw(m);
    expect(document.querySelector("[data-send-queue]")).toBeNull();
    expect(document.querySelector("[data-gui-kind='collection']")).not.toBeNull();
  });
});

describe("Gridtop's send-queue renderer: drawing", () => {
  beforeAll(async () => {
    await loadLazyRenderers(GridtopGui, [model()]);
  }, 30_000);

  it.each([
    ["bills with links", model],
    ["no payment provider", unconfigured],
    ["no bills", noBills],
    ["billing off", billingOff],
  ])("passes the conformance view checks, with acme.poke offered: %s", async (name, m) => {
    expect(await checkModel(GridtopGui, withPoke(m()), name)).toEqual([]);
  }, 60_000);

  it("draws a card per bill, with the link as selectable text and never an anchor", async () => {
    await draw(model());
    const [first, second, paid] = cards();
    expect(within(first).getByRole("link", { name: TENANTS[0] }).getAttribute("href")).toBe(`/microgrids/${MG}/setup/tenants/${tenantId(0)}`);
    expect(within(first).getByText("UGX 55,875")).toBeTruthy();
    expect(within(first).getByText("Unpaid")).toBeTruthy();
    expect(within(first).getByText(urlOf(0)).tagName).not.toBe("A");
    expect(document.querySelector(`a[href="${urlOf(0)}"]`)).toBeNull();
    expect(within(second).getByRole("button", { name: `Copy payment link for ${TENANTS[1]}` })).toBeTruthy();
    // A paid bill: its note, no link and no Copy.
    expect(within(paid).getByText(PAID_NOTE)).toBeTruthy();
    expect(within(paid).queryByRole("button", { name: /Copy payment link/ })).toBeNull();
    // Each bill's PDF, and the period's links when not on its own page.
    expect(within(first).getByRole("link", { name: "Download bill (PDF)" }).getAttribute("href")).toBe(pdf(0).href);
    expect(screen.getByRole("link", { name: "Back to period" })).toBeTruthy();
  });

  it("copies the link and announces it, without reading the link out", async () => {
    const writeText = clipboard();
    await draw(model());
    fireEvent.click(screen.getByRole("button", { name: `Copy payment link for ${TENANTS[0]}` }));
    await waitFor(() => expect(said()).toBe(copiedMessage(TENANTS[0])));
    expect(writeText).toHaveBeenCalledWith(urlOf(0));
    expect(said()).not.toContain(ORIGIN);
    // The same copy again is announced again.
    fireEvent.click(screen.getByRole("button", { name: `Copy payment link for ${TENANTS[0]}` }));
    await waitFor(() => expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(`${copiedMessage(TENANTS[0])}${REPEAT}`));
  });

  it("says what to do when the clipboard refuses, and when there is none", async () => {
    clipboard(true);
    await draw(model());
    fireEvent.click(screen.getByRole("button", { name: `Copy payment link for ${TENANTS[1]}` }));
    await waitFor(() => expect(said()).toBe(copyFailedMessage(TENANTS[1])));
    unmount?.();
    Reflect.deleteProperty(navigator, "clipboard");
    await draw(model());
    fireEvent.click(screen.getByRole("button", { name: `Copy payment link for ${TENANTS[0]}` }));
    await waitFor(() => expect(said()).toBe(copyFailedMessage(TENANTS[0])));
  });

  it("shows the readiness note, and no Copy without links", async () => {
    await draw(unconfigured());
    expect(screen.getByText(NOT_SET_UP)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy payment link/ })).toBeNull();
  });

  it("shows the empty state with no bills", async () => {
    await draw(noBills());
    expect(screen.getByRole("heading", { name: "No bills to send yet." })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Bills to send" })).toBeNull();
  });

  it("shows the host's notice", async () => {
    await draw(billingOff());
    expect(screen.getByText(BILLING_OFF)).toBeTruthy();
  });
});
