/**
 * The `billing.send-queue` model: one row per bill of a tenant the person
 * can read, in the tenants' order; a link exactly where checkout would
 * accept it and readiness allows; each bill's note; the readiness subtitle
 * and note by state and role; the ext lining up with the rows; the title,
 * links and empty states; and no contact details anywhere.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import type { PaymentStatus } from "@/lib/payments/state";
import { BILLING_SURFACE } from "../../surface";
import { SendQueueExt } from "../send-queue-ext";
import { SEND_QUEUE_EXAMPLES, SEND_QUEUE_LOADED_EXAMPLES } from "../send-queue-examples";
import {
  billNote,
  buildSendQueueModel,
  linksOffered,
  readinessNote,
  SEND_QUEUE_COPY,
  SEND_QUEUE_EXT_SCHEMA,
  SEND_QUEUE_KEYS,
  SEND_QUEUE_SUBTITLES,
  type SendBill,
  type SendQueueInput,
  type SendReadiness,
} from "../send-queue-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e8100000-0000-4000-8000-0000000000a1";
const PERIOD = "e8100000-0000-4000-8000-0000000000b1";
const ORIGIN = "https://mgm.example.org";
const t = (n: number, hasContact = true) => ({ id: `e8100000-0000-4000-8000-0000000000c${n}`, display_name: `House ${n}`, hasContact });
const b = (n: number, o: Partial<SendBill> = {}): SendBill => ({
  id: `e8100000-0000-4000-8000-0000000000d${n}`,
  tenant_id: t(n).id,
  total_amount: 2500,
  payment_status: "unpaid",
  invoice_number: null,
  ...o,
});

const input = (o: Partial<SendQueueInput> = {}): SendQueueInput => ({
  microgrid: { id: MG, name: "North site", currency: "UGX" },
  period: { id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala" },
  tenants: [t(1), t(2), t(3)],
  bills: [b(1), b(2), b(3)],
  readiness: "ready",
  linkFor: (id) => `${ORIGIN}/api/billing-line-items/${id}/pay`,
  superAdmin: false,
  fmt,
  ...o,
});
const build = (o: Partial<SendQueueInput> = {}) => buildSendQueueModel(input(o));
const extOf = (o: Partial<SendQueueInput> = {}) => SendQueueExt.parse(build(o).ext!.data);

const STATUSES: PaymentStatus[] = ["unpaid", "link_generated", "paid", "failed", "refunded"];
const READINESS: SendReadiness[] = ["ready", "sandbox", "disabled", "unconfigured", "connection_error", "unchecked", "no_address"];

const view = BILLING_SURFACE.views!.find((v) => v.id === "billing.send-queue") as ViewDef;

describe("buildSendQueueModel: the rows", () => {
  it("emits only the declared keys, with the columns in order", () => {
    const model = build();
    expect(model.body.columns.map((c) => [c.key, c.label, c.type, c.priority])).toEqual([
      ["tenant", "Tenant", "ref", 1],
      ["total", "Total", "money", 1],
      ["payment", "Payment", "status", 1],
      ["link", "Payment link", "text", 1],
      ["note", "Note", "text", 2],
    ]);
    for (const row of model.body.rows) expect(Object.keys(row.cells).sort()).toEqual([...SEND_QUEUE_KEYS].sort());
    expect(view.declares.keys).toEqual(SEND_QUEUE_KEYS);
  });

  it("lists the bills in the tenants' order, skipping tenants with no bill and bills of tenants the person cannot read", () => {
    const model = build({ tenants: [t(3), t(1), t(4)], bills: [b(1), b(2), b(3)] });
    expect(model.body.rows.map((r) => r.id)).toEqual([b(3).id, b(1).id]);
  });

  it("gives each row its bill, tenant, link, note, download and no actions", () => {
    const row = build().body.rows[0];
    const tenantRef = { kind: "tenant", id: t(1).id, label: "House 1", href: `/microgrids/${MG}/setup/tenants/${t(1).id}` };
    expect(row).toEqual({
      id: b(1).id,
      entity: { kind: "lineItem", id: b(1).id, label: "House 1" },
      related: [tenantRef],
      cells: {
        tenant: fmt.ref(tenantRef as never),
        total: fmt.money(2500, "UGX"),
        payment: fmt.status("billingLineItemPaymentStatus", "unpaid"),
        link: fmt.text(`${ORIGIN}/api/billing-line-items/${b(1).id}/pay`),
        note: fmt.empty(),
      },
      actions: [],
      links: [
        {
          id: "billing.download-bill",
          label: "Download bill (PDF)",
          icon: "download",
          href: `/api/billing-line-items/${b(1).id}/pdf`,
          download: { mime: "application/pdf", filename: `bill-${b(1).id}.pdf` },
        },
      ],
    });
  });

  const cases = STATUSES.flatMap((status) =>
    READINESS.flatMap((readiness) => [2500, 0, -5].flatMap((total) => [true, false].map((contact) => [status, readiness, total, contact] as const))),
  );
  it.each(cases)("%s, readiness %s, total %s, contact %s: a link exactly where checkout would accept it", (status, readiness, total, contact) => {
    const model = build({ tenants: [t(1, contact)], bills: [b(1, { payment_status: status, total_amount: total })], readiness });
    const row = model.body.rows[0];
    const sendable = status !== "paid" && status !== "refunded" && total > 0 && contact;
    const linked = sendable && (readiness === "ready" || readiness === "sandbox");
    expect(row.cells.link).toEqual(linked ? fmt.text(`${ORIGIN}/api/billing-line-items/${b(1).id}/pay`) : fmt.empty());
    expect(extOf({ tenants: [t(1, contact)], bills: [b(1, { payment_status: status, total_amount: total })], readiness }).rows).toEqual([
      { id: b(1).id, url: linked ? `${ORIGIN}/api/billing-line-items/${b(1).id}/pay` : null },
    ]);
    // A bill's own note does not depend on readiness.
    const note =
      status === "paid"
        ? SEND_QUEUE_COPY.paid
        : status === "refunded"
          ? SEND_QUEUE_COPY.refunded
          : total <= 0
            ? SEND_QUEUE_COPY.zero
            : !contact
              ? SEND_QUEUE_COPY.noContact
              : null;
    expect(row.cells.note).toEqual(note === null ? fmt.empty() : fmt.text(note));
  });

  it("asks for a link only for a bill it shows one for", () => {
    const asked: string[] = [];
    build({
      tenants: [t(1), t(2), t(3, false)],
      bills: [b(1), b(2, { payment_status: "paid" }), b(3)],
      linkFor: (id) => (asked.push(id), `${ORIGIN}/x/${id}`),
    });
    expect(asked).toEqual([b(1).id]);
    asked.length = 0;
    build({ readiness: "disabled", linkFor: (id) => (asked.push(id), "") });
    expect(asked).toEqual([]);
  });

  it("notes each reason a bill has no link", () => {
    expect(billNote(b(1, { payment_status: "paid" }), t(1))).toBe("Paid: no link to send.");
    expect(billNote(b(1, { payment_status: "refunded" }), t(1))).toBe("Refunded: no link to send.");
    expect(billNote(b(1, { total_amount: 0 }), t(1))).toBe("Nothing to collect.");
    expect(billNote(b(1, { total_amount: Number.NaN }), t(1))).toBe("Nothing to collect.");
    expect(billNote(b(1), t(1, false))).toBe("No email or phone for this tenant, so checkout would refuse. Add one on the tenant's page.");
    // A failed payment and a pending link can be sent again.
    expect(billNote(b(1, { payment_status: "failed" }), t(1))).toBeNull();
    expect(billNote(b(1, { payment_status: "link_generated" }), t(1))).toBeNull();
  });

  it("links a closed period's unpaid bills too: draft and closed bills are payable", () => {
    const model = build({ period: { ...input().period, status: "closed" } });
    expect(model.body.rows.every((r) => r.cells.link.t === "text")).toBe(true);
  });
});

describe("buildSendQueueModel: readiness", () => {
  it("offers links only while ready or sandbox", () => {
    expect(READINESS.filter(linksOffered)).toEqual(["ready", "sandbox"]);
  });

  it.each(READINESS.flatMap((r) => [false, true].map((superAdmin) => [r, superAdmin] as const)))(
    "%s (super admin %s): the subtitle and note",
    (readiness, superAdmin) => {
      const model = build({ readiness, superAdmin });
      const note = extOf({ readiness, superAdmin }).note;
      expect(note).toEqual(readinessNote(readiness, superAdmin));
      if (readiness === "ready") {
        expect(model.subtitle).toBe("Africa/Kampala");
        expect(note).toBeNull();
        return;
      }
      expect(model.subtitle).toBe(SEND_QUEUE_SUBTITLES[readiness]);
      expect(note?.tone).toBe(readiness === "sandbox" ? "info" : "warning");
    },
  );

  it("tells a super admin to connect a provider and anyone else to ask one, as the legacy banner does", () => {
    expect(readinessNote("unconfigured", true)?.text).toBe(
      "No payment provider is configured. Connect a payment provider on the community's Payment page to send payment links.",
    );
    expect(readinessNote("unconfigured", false)?.text).toBe("No payment provider is configured. Ask a super admin to configure Payment for this community.");
    expect(readinessNote("connection_error", false)?.text).toBe(
      "The payment account failed its last connection test, so there are no links to send. Ask a super admin to configure Payment for this community.",
    );
    expect(readinessNote("sandbox", false)?.text).toBe("Payment links use a sandbox account: payments made through them are tests.");
    expect(readinessNote("disabled", true)?.text).toBe("Online payments are turned off for this organization, so there are no links to send.");
    expect(readinessNote("unchecked", true)?.text).toBe(SEND_QUEUE_COPY.unchecked);
    expect(readinessNote("no_address", true)?.text).toBe(SEND_QUEUE_COPY.noAddress);
  });
});

describe("buildSendQueueModel: the period", () => {
  it("titles the period by name, with its links and no actions", () => {
    const model = build();
    expect(model.title).toBe("Send October 2026 bills");
    expect(model.entity).toEqual({ kind: "billingPeriod", id: PERIOD, label: "1 Oct 2026 – 31 Oct 2026" });
    expect(model.actions).toEqual([]);
    expect(model.links).toEqual([
      { id: "billing.back-to-period", label: "Back to period", href: `/microgrids/${MG}/billing/${PERIOD}` },
      { id: "billing.view-history", label: "View history", href: `/microgrids/${MG}/billing/${PERIOD}/history` },
    ]);
  });

  it("names a one-day period by its day", () => {
    expect(build({ period: { ...input().period, start_date: "2026-10-05", end_date: "2026-10-05" } }).title).toBe("Send 5 October 2026 bills");
  });

  it("shows an empty state with no bills and with no tenants", () => {
    expect(build({ bills: [] }).body).toMatchObject({
      rows: [],
      empty: { title: "No bills to send yet.", text: "Generate this period's bills on the period page first." },
    });
    expect(build({ tenants: [], bills: [] }).body.empty).toEqual({ title: "No tenants configured for this microgrid." });
  });

  it("lines the ext up with the rows, with a url exactly where the link cell has one", () => {
    const model = build({ tenants: [t(1), t(2), t(3, false)], bills: [b(1), b(2, { payment_status: "paid" }), b(3)] });
    expect(model.ext!.schema).toBe(SEND_QUEUE_EXT_SCHEMA);
    const ext = SendQueueExt.parse(model.ext!.data);
    expect(ext.rows.map((r) => r.id)).toEqual(model.body.rows.map((r) => r.id));
    for (const [n, row] of model.body.rows.entries()) {
      expect(ext.rows[n].url).toBe(row.cells.link.t === "text" ? row.cells.link.text : null);
    }
  });
});

describe("the send queue's examples", () => {
  it("each pass the host's strict check against the view, as loaded and as received", () => {
    for (const model of SEND_QUEUE_LOADED_EXAMPLES) expect(strictParseModel(view, model)).toMatchObject({ ok: true });
    expect(view.examples).toBe(SEND_QUEUE_EXAMPLES);
    expect(SEND_QUEUE_EXAMPLES.length).toBe(SEND_QUEUE_LOADED_EXAMPLES.length + 1);
  });

  it("carry no environment's origin, and the view is not readable by an assistant", () => {
    for (const model of SEND_QUEUE_LOADED_EXAMPLES) {
      for (const row of SendQueueExt.parse(model.ext!.data).rows) if (row.url) expect(row.url.startsWith(`${ORIGIN}/api/billing-line-items/`)).toBe(true);
    }
    expect(view).not.toHaveProperty("agent");
  });

  it("puts no email address or phone number in a model", () => {
    for (const model of SEND_QUEUE_LOADED_EXAMPLES) {
      const json = JSON.stringify(model);
      expect(json).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
      expect(json).not.toMatch(/\+\d{6,}/);
    }
  });
});
