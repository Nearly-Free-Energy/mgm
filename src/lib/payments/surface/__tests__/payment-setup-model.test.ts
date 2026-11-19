/**
 * The `payments.payment-setup` model: each readiness state's chip and what
 * to do about it, by role as the legacy banner advises (a super admin gets
 * the link to the community's Payment page, anyone else is told to ask
 * one); turning payments on advised to every role; and the examples, one
 * per state, carrying the link only for a super admin.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { PAYMENT_SETUP_EXAMPLES, PAYMENT_SETUP_LOADED_EXAMPLES } from "../payment-setup-examples";
import {
  buildPaymentSetupModel,
  COMMUNITY_PAYMENT_LINK,
  nextStep,
  PAYMENT_SETUP_COPY as C,
  PAYMENT_SETUP_KEYS,
  SETUP_READINESS,
  type SetupReadiness,
} from "../payment-setup-model";

const COMMUNITY = "e8400000-0000-4000-8000-0000000000a2";
const fmt = createFmt({ locale: "en-GB" });
const build = (readiness: SetupReadiness, superAdmin: boolean) => buildPaymentSetupModel({ communityId: COMMUNITY, readiness, superAdmin, fmt });

describe("the payment setup model", () => {
  it.each([
    ["ready", "Live", "success", C.ready, C.ready],
    ["sandbox", "Sandbox", "warning", `${C.sandbox} ${C.sandboxFix}`, `${C.sandbox} ${C.sandboxAsk}`],
    ["disabled", "Off", "neutral", C.disabled, C.disabled],
    ["unconfigured", "Not set up", "warning", `${C.unconfigured} ${C.unconfiguredFix}`, `${C.unconfigured} ${C.ask}`],
    ["connection_error", "Not connected", "danger", `${C.connectionError} ${C.connectionErrorFix}`, `${C.connectionError} ${C.ask}`],
    ["unchecked", "Not checked", "neutral", C.unchecked, C.unchecked],
  ] as const)("shows %s as %s (%s), with its advice by role", (state, label, tone, forSuperAdmin, forManager) => {
    for (const [superAdmin, next] of [
      [true, forSuperAdmin],
      [false, forManager],
    ] as const) {
      const model = build(state, superAdmin);
      expect(model.body.sections).toEqual([
        {
          fields: [
            { key: "status", label: C.statusLabel, value: { t: "status", v: state, tone, text: label } },
            { key: "next", label: C.nextLabel, value: { t: "text", text: next } },
          ],
        },
      ]);
      expect(nextStep(state, superAdmin)).toBe(next);
    }
  });

  it("covers every state", () => {
    expect([...SETUP_READINESS].sort()).toEqual(["connection_error", "disabled", "ready", "sandbox", "unchecked", "unconfigured"]);
  });

  it("links a super admin, and only a super admin, to the community's Payment page, in every state", () => {
    for (const state of SETUP_READINESS) {
      expect(build(state, true).links).toEqual([{ id: COMMUNITY_PAYMENT_LINK, label: C.linkLabel, href: `/communities/${COMMUNITY}/payment` }]);
      expect(build(state, false).links).toEqual([]);
    }
  });

  it("offers no actions and emits only its declared keys", () => {
    const model = build("unconfigured", true);
    expect(model.actions).toEqual([]);
    expect(model.body.sections.flatMap((s) => s.fields.map((f) => f.key))).toEqual([...PAYMENT_SETUP_KEYS]);
  });
});

describe("the payment setup examples", () => {
  it("show every state, and the link for a super admin in at least one", () => {
    const states = PAYMENT_SETUP_LOADED_EXAMPLES.map((m) => m.body.sections[0].fields[0].value).map((v) => (v.t === "status" ? v.v : null));
    expect([...new Set(states)].sort()).toEqual([...SETUP_READINESS].sort());
    expect(PAYMENT_SETUP_EXAMPLES.some((m) => m.links.some((l) => l.id === COMMUNITY_PAYMENT_LINK))).toBe(true);
    expect(PAYMENT_SETUP_EXAMPLES.some((m) => m.links.length === 0)).toBe(true);
  });

  it("carry the gate's notice only where payments are off", () => {
    for (const m of PAYMENT_SETUP_EXAMPLES) {
      const state = m.body.sections[0].fields[0].value;
      expect(m.notice !== undefined, state.text).toBe(state.t === "status" && state.v === "disabled");
    }
  });
});
