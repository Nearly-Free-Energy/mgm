import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MerchantSettings } from "../merchant-settings";
const fetchMock = vi.fn();
const account = { id: "account-1", display_name: "Pilot sandbox", is_default: true, sandbox: true, last_test_status: "ok", consumer_key: "public-key" };
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
