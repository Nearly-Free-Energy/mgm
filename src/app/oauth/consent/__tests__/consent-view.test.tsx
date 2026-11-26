// @vitest-environment jsdom
/**
 * The consent page's question (#271, ADR-008 decision 3).
 *
 * Coverage:
 *   - It names the client, its kind and what that kind may do; an agent
 *     client's page says where the assistant's reads go.
 *   - The warning shows, and nothing asks Supabase Auth or MGM anything,
 *     until a click: Supabase Auth would approve a client approved before
 *     on its first look.
 *   - Connect records the approval first, then asks Supabase Auth, then loads
 *     the code page; a refused record asks Supabase Auth nothing.
 *   - Don't connect asks nobody.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConsentClient } from "@/lib/auth/client-consent";

const mocks = vi.hoisted(() => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  loadPage: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      oauth: {
        getAuthorizationDetails: mocks.getAuthorizationDetails,
        approveAuthorization: mocks.approveAuthorization,
      },
    },
  }),
}));
vi.mock("../load-page", () => ({ loadPage: mocks.loadPage }));

import { ConsentView } from "../consent-view";

const ID = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const OPERATOR: ConsentClient = { id: "c-1", kind: "operator", label: "MGM CLI" };
const AGENT: ConsentClient = { id: "c-2", kind: "agent", label: "MGM assistant bridge" };

vi.stubGlobal("fetch", mocks.fetch);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(client: ConsentClient = OPERATOR) {
  render(<ConsentView authorizationId={ID} client={client} email="aaron@example.org" />);
}

const codeUrl = () => `${window.location.origin}/oauth/code?code=3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b&state=s`;

describe("ConsentView", () => {
  it("names the client, the account, its kind and what it may do, and warns before anything is asked", () => {
    show();
    expect(screen.getByRole("heading", { name: "Connect MGM CLI?" })).toBeTruthy();
    expect(document.body.textContent).toContain("aaron@example.org");
    expect(document.body.textContent).toContain("Command line");
    expect(document.body.textContent).toContain("It can see and change everything you can in MGM");
    expect(document.body.textContent).toContain("A program on the computer that ran the command will act as you.");
    expect(document.body.textContent).toContain("Continue only if you ran mgm login yourself just now.");
    expect(document.body.textContent).not.toContain("company that runs the assistant");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(mocks.approveAuthorization).not.toHaveBeenCalled();
  });

  it("says, for an agent client, that what the assistant reads goes to its provider", () => {
    show(AGENT);
    expect(document.body.textContent).toContain("Assistant");
    expect(document.body.textContent).toContain("cannot change anything");
    expect(document.body.textContent).toContain("What the assistant reads in MGM goes to the company that runs the assistant.");
  });

  it("on Connect records the approval, then asks Supabase Auth, then loads the code page", async () => {
    const order: string[] = [];
    mocks.fetch.mockImplementation(async () => {
      order.push("record");
      return Response.json({ client_id: "c-1", kind: "operator" }, { status: 201 });
    });
    mocks.getAuthorizationDetails.mockImplementation(async () => {
      order.push("details");
      return { data: { redirect_url: codeUrl() }, error: null };
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.loadPage).toHaveBeenCalledWith(codeUrl()));
    expect(order).toEqual(["record", "details"]);
    expect(mocks.fetch.mock.calls[0][0]).toBe("/api/auth/oauth/approvals");
    expect(mocks.approveAuthorization).not.toHaveBeenCalled();
  });

  it("shows MGM's reason and asks Supabase Auth nothing when the approval is not recorded", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "This sign-in has already been answered. Run mgm login again for a new one." }, { status: 409 })
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already been answered/);
    expect(mocks.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it("asks nobody on Don't connect", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Don't connect" }));
    expect(await screen.findByRole("heading", { name: "Not connected" })).toBeTruthy();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(mocks.approveAuthorization).not.toHaveBeenCalled();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });
});
