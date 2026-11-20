/**
 * The path of a bill's stable payment link: what the tenant opens to pay.
 * GET on it (src/app/api/billing-line-items/[lineItemId]/pay/route.ts) needs
 * no session and starts or reuses a checkout for the bill's current
 * revision, so the line-item id in it is the link's only access token.
 *
 * Pure, so a billing view can build the same link the capability hands out
 * (PaymentsCapability.stablePaymentLink) and invoices embed, without
 * composing payments for each bill. The caller makes it absolute with the
 * application's origin (appUrl, @/lib/config/app-url).
 */
export const stablePaymentLinkPath = (lineItemId: string) => `/api/billing-line-items/${lineItemId}/pay` as const;
