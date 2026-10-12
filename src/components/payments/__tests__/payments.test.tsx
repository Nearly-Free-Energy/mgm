import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MerchantSettings } from "../merchant-settings";
import { PaymentHistory } from "../payment-history";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const fetchMock = vi.fn();
const account = { id: "account-1", display_name: "Pilot sandbox", is_default: true, sandbox: true, last_test_status: "ok", consumer_key: "public-key" };
const history = { attempts: [{ id: "attempt-1", amount: 100, currency: "UGX", status: "needs_reconciliation", merchant_reference: "bill-reference" }], receipts: [], currentTotal: 100, received: 80, difference: 20, currency: "UGX" };
function response(value: unknown, ok = true) { return { ok, json: async () => value }; }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("can remove a community override and inherit its organization default", async () => {
 fetchMock.mockImplementation(async (_url, options) => response(options ? {} : String(_url).endsWith("override") ? { override: { merchant_account_id: account.id } } : { accounts: [account] }));
 render(<MerchantSettings orgId="org-1" communityId="community-1" />);
 await waitFor(() => expect((screen.getByLabelText("Community account") as HTMLSelectElement).value).toBe(account.id));
 fireEvent.change(screen.getByLabelText("Community account"), { target: { value: "" } });
 fireEvent.click(screen.getByText("Save community selection"));
 await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/communities/community-1/payment/override", expect.objectContaining({ method: "DELETE" })));
});
it("shows a failed credential test without claiming the configuration was saved", async () => {
 fetchMock.mockImplementation(async (_url, options) => response(options ? { error: "Candidate authentication failed" } : { accounts: [account] }, !options));
 render(<MerchantSettings orgId="org-1" />);
 await screen.findByText(/Pilot sandbox/, { selector: "li" });
 fireEvent.change(screen.getByLabelText("Consumer key"), { target: { value: "candidate" } });
 fireEvent.click(screen.getByText("Save and test connection"));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Payment configuration failedCandidate authentication failed");
 expect(screen.queryByRole("status")).toBeNull();
 expect(screen.getByText(/Pilot sandbox/, { selector: "li" })).toBeTruthy();
});
it("shows reconciliation amounts and records only the entered external adjustment", async () => {
 fetchMock.mockImplementation(async (_url, options) => response(options ? {} : history));
 render(<PaymentHistory lineItemId="bill-1" />);
 fireEvent.click(screen.getByText("Payment history"));
 await screen.findByText(/Difference: 20 UGX/);
 fireEvent.change(screen.getByLabelText("External amount (negative for refund)"), { target: { value: "20" } });
 fireEvent.change(screen.getByLabelText("External reference"), { target: { value: "cash-receipt-1" } });
 fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Cash collected by manager" } });
 fireEvent.click(screen.getByText("Record completed adjustment"));
 await waitFor(() => expect(refresh).toHaveBeenCalled());
 const call = fetchMock.mock.calls.find(call => call[1]?.method === "POST");
 expect(JSON.parse(call![1].body)).toEqual({ action: "record_external", externalAmount: 20, externalReference: "cash-receipt-1", notes: "Cash collected by manager" });
});
