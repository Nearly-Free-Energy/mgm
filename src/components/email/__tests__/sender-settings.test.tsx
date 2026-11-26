// @vitest-environment jsdom
/**
 * SenderSettings, the organization email page: its Remove dialog asks for
 * the saved mail server's name, typed, and sends it as
 * DELETE /api/organizations/[id]/email-sender requires
 * (org.remove-email-sender is a typed action).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SenderSettings } from "../sender-settings";

const ORG = "11111111-1111-4111-8111-111111111111";
const SAVED = {
  org_id: ORG,
  host: "smtp.example.com",
  port: 587,
  username: "notices@example.com",
  from_address: "notices@example.com",
  from_name: "Kiwumu Energy",
  reply_to: null,
  version: 3,
  last_tested_at: "2026-11-16T10:00:00Z",
  last_test_status: "success",
  last_test_message: "Test email sent to manager@example.org.",
  created_at: "2026-11-16T09:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SenderSettings — remove", () => {
  it("enables Remove only once the server's name is typed, and sends it as the route requires", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "DELETE"
        ? new Response(JSON.stringify({ sender: null }), { status: 200 })
        : new Response(JSON.stringify({ sender: SAVED }), { status: 200 })
    );
    render(<SenderSettings orgId={ORG} />);

    fireEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    const confirm = () => screen.getAllByRole("button", { name: /^remove$/i }).at(-1)!;
    const typed = screen.getByLabelText(/type the mail server's name to confirm/i);
    expect(confirm().hasAttribute("disabled")).toBe(true);
    fireEvent.change(typed, { target: { value: "smtp.other.com" } });
    expect(confirm().hasAttribute("disabled")).toBe(true);
    fireEvent.change(typed, { target: { value: "smtp.example.com" } });
    expect(confirm().hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm());

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [url, init] = fetchSpy.mock.calls[1]!;
    expect(url).toBe(`/api/organizations/${ORG}/email-sender`);
    expect((init as RequestInit).method).toBe("DELETE");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ confirmation: { acknowledged: [], typed: "smtp.example.com" } });
    expect(await screen.findByText(/email settings removed/i)).toBeDefined();
  });
});
