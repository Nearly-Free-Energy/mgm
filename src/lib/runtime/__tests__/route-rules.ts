/**
 * What route-surface.test.ts knows about route files that gui-surface.test.ts
 * (src/lib/gui/__tests__) needs too: the gate exemptions and how a handler's
 * code is found. Kept here so neither test imports the other, which would run
 * its tests twice.
 */
import type { PaymentsCapabilityContract } from "@/lib/payments/repository";

/** A handler's key in UNGATED_WRITES: `METHOD /api/route`, every bracket spelled `[id]`. */
export function exemptionKey(method: string, route: string): string {
  return `${method} ${route.replace(/\[[^\]]+\]/g, "[id]")}`;
}

/**
 * An exemption for a write route that reaches the Payments capability. Its
 * reason is not taken on trust: route-surface.test.ts's "holds each payment
 * exemption to the method it names" checks that the route file (all of it, not only the handler)
 * composes Payments, calls exactly `reaches` on the capability, and hands
 * neither the capability nor its composition on. What `reaches` may write or
 * ask the provider is pinned by capability-gating.test.ts, and what the
 * route does besides (no write and no outbound call outside the capability,
 * apart from the exceptions listed there) by check 4 of
 * payments-route-boundary.test.ts, both in src/lib/payments/__tests__.
 * Check 4 also refuses any other module the route runs that loads the
 * composer, which is why the route file is the only place this looks for
 * capability calls; if check 4 stops doing that, follow the route's imports
 * here instead. Check 4 holds only routes Payments or Pesapal owns, so an
 * exempt route must be owned by one of them; if check 4's `COMPOSER_OWNERS`
 * changes, revisit that requirement here.
 */
export type PaymentExemption = {
  reason: string;
  /** The one capability method the route calls. It may not refuse a disabled plugin. */
  reaches: keyof PaymentsCapabilityContract;
};

/**
 * Write handlers that intentionally do not consult the gate. Each needs a
 * reason a reviewer can check; a handler that reaches the Payments
 * capability needs a `PaymentExemption`, which the test checks too.
 */
export const UNGATED_WRITES: Record<string, string | PaymentExemption> = {
  "POST /api/edges":
    "Retired endpoint; always answers 410 without touching data.",
  "POST /api/organizations/[id]/payment-accounts":
    "Merchant setup precedes enabling Payments (docs/payments-rollout.md); checkout is gated in the capability.",
  "PUT /api/communities/[id]/payment/override":
    "Payment configuration is allowed while Payments is off; checkout is gated in the capability.",
  "DELETE /api/communities/[id]/payment/override":
    "Payment configuration is allowed while Payments is off; checkout is gated in the capability.",
  "PUT /api/communities/[id]/payment":
    "Informational stub; always answers 409 without touching data.",
  "POST /api/communities/[id]/invoice-preview":
    "Renders a preview from submitted branding; billing reads stay available while disabled.",
  // The payment write routes below each reach one Payments capability method
  // that only reads, or keeps running while Payments or Pesapal is off by
  // design (docs/payments-rollout.md).
  "POST /api/billing-line-items/[id]/url": {
    reason:
      "Returns the stable payment link without contacting the provider; checkout starts when the customer follows it, behind ensureCheckout's plugin check. Wrong once the link starts a checkout itself.",
    reaches: "stablePaymentLink",
  },
  "POST /api/payments/attempts/[id]/refresh": {
    reason:
      "Re-verifies an attempt already submitted to the provider; the rollout rule keeps verification available while Payments is off. Wrong once that rule changes or refresh submits anything new.",
    reaches: "refreshPaymentStatus",
  },
  "POST /api/payments/attempts/[id]/reconcile": {
    reason:
      "Records a manager's resolution of an attempt already flagged for reconciliation, which the payments_disabled message promises to preserve; calls no provider. Wrong once that promise is withdrawn.",
    reaches: "reconcile",
  },
  "POST /api/payments/ipn": {
    reason:
      "The provider's notification about money that already moved; verification stays available while Payments or Pesapal is off. Wrong once the rollout rule stops keeping verification available.",
    reaches: "handleNotification",
  },
  "POST /api/payments/reconcile-worker": {
    reason:
      "Retries stored provider notifications through the same verification as the IPN route. Wrong once the rollout rule stops keeping verification available.",
    reaches: "handleNotification",
  },
};

const HANDLER_RE =
  /^export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b|(?:const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*=\s*([A-Za-z_$][\w$]*)\s*;)/gm;

/** Top-level declarations: `name → source text` (functions and arrow consts). */
function topLevelBlocks(source: string): Map<string, string> {
  const starts = [
    ...source.matchAll(
      /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm
    ),
  ];
  const blocks = new Map<string, string>();
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    blocks.set(match[1] ?? match[2], source.slice(match.index, end));
  });
  return blocks;
}

/**
 * The source a handler runs: its own body plus the bodies of local
 * functions it calls (transitively), so a gate inside a shared helper counts
 * but a gate in a sibling handler does not. Payment exemptions are checked
 * against the whole route file instead (`paymentExemptionProblems`
 * in route-surface.test.ts).
 */
export function handlerSources(source: string): Map<string, string> {
  const blocks = topLevelBlocks(source);
  const reach = (name: string): string => {
    const seen = new Set<string>();
    const queue = [name];
    let text = "";
    while (queue.length) {
      const next = queue.shift() as string;
      if (seen.has(next) || !blocks.has(next)) continue;
      seen.add(next);
      const block = blocks.get(next) as string;
      text += block;
      for (const candidate of blocks.keys()) {
        if (!seen.has(candidate) && new RegExp(`\\b${candidate}\\(`).test(block)) {
          queue.push(candidate);
        }
      }
    }
    return text;
  };
  const result = new Map<string, string>();
  for (const match of source.matchAll(HANDLER_RE)) {
    const method = match[1] ?? match[2];
    result.set(method, reach(match[3] ?? method));
  }
  return result;
}
