// @vitest-environment jsdom
/**
 * TenantAccessSection — App access on the tenant record (RFC mgm#197 § 6).
 *
 * fetch and the router are mocked; every other component renders for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TenantAccessSection, type TenantAccessSectionProps } from "./tenant-access-section";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
}));

const TENANT_ID = "7e550000-0000-4000-8005-000000000001";
const ENTRY = {
  accessId: "7e550000-0000-4000-8008-000000000001",
  email: "renter@example.test",
  // 22:30 UTC is already the next day in Kampala (UTC+3).
  createdAt: "2026-11-18T22:30:00Z",
};
const SECOND = {
  accessId: "7e550000-0000-4000-8008-000000000002",
  email: "partner@example.test",
  createdAt: "2026-11-01T08:00:00Z",
};

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSection(props: Partial<TenantAccessSectionProps> = {}) {
  return render(
    <TenantAccessSection
      tenantId={TENANT_ID}
      entries={[]}
      suggestedEmail="renter@example.test"
      canManage
      tenantAppOn
      timeZone="Africa/Kampala"
      loginUrl="https://mgm.example.test/login"
      {...props}
    />
  );
}

const giveAccessButtons = () => screen.queryAllByRole("button", { name: "Give access" });

async function giveAccess(email: string, answer: Response) {
  fetchMock.mockResolvedValueOnce(answer);
  fireEvent.click(screen.getByRole("button", { name: "Give access" }));
  const dialog = await screen.findByRole("dialog");
  const field = within(dialog).getByLabelText("Email address");
  fireEvent.change(field, { target: { value: email } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Give access" }));
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TenantAccessSection: what it shows", () => {
  it("shows the empty state with Give access, and no list, while nobody has access", () => {
    renderSection();
    expect(screen.getByRole("heading", { name: "App access" })).toBeTruthy();
    expect(screen.getByText("Give this tenant access to the app")).toBeTruthy();
    expect(screen.getByText(/Nobody can sign in to this unit yet/)).toBeTruthy();
    expect(giveAccessButtons()).toHaveLength(1);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists each address with the day it was added, in the microgrid's zone", () => {
    renderSection({ entries: [ENTRY, SECOND] });
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("renter@example.test");
    expect(items[0].textContent).toContain("Added Nov 19, 2026");
    expect(items[1].textContent).toContain("partner@example.test");
    expect(items[1].textContent).toContain("Added Nov 1, 2026");
  });

  it("never shows the empty state beside the list's Give access", () => {
    renderSection({ entries: [ENTRY] });
    expect(screen.queryByText("Give this tenant access to the app")).toBeNull();
    expect(screen.queryByRole("region", { name: "Give this tenant access to the app" })).toBeNull();
    expect(giveAccessButtons()).toHaveLength(1);
  });

  it("shows an error, no Give access and no empty state when the list could not be read", () => {
    renderSection({ entries: null });
    expect(screen.getByRole("alert").textContent).toContain("Could not load app access");
    expect(giveAccessButtons()).toHaveLength(0);
    expect(screen.queryByText(/Nobody can sign in/)).toBeNull();
  });

  it("hides Give access while the tenant app is off, and keeps Remove", () => {
    renderSection({ entries: [ENTRY], tenantAppOn: false });
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("The tenant app is not on yet");
    expect(banner.textContent).not.toMatch(/settings|plugins/i);
    expect(giveAccessButtons()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Remove access for renter@example.test" })).toBeTruthy();
  });

  it("offers Give access when the tenant app's state could not be read", () => {
    renderSection({ tenantAppOn: null });
    expect(giveAccessButtons()).toHaveLength(1);
  });

  it("offers neither Give access nor Remove to someone who cannot manage the unit", () => {
    renderSection({ entries: [ENTRY], canManage: false });
    expect(giveAccessButtons()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("says who can give access when the empty state has no button", () => {
    renderSection({ canManage: false });
    expect(giveAccessButtons()).toHaveLength(0);
    expect(screen.getByText("Only an organization manager can give access.")).toBeTruthy();
  });
});

describe("TenantAccessSection: Give access", () => {
  it("labels the field and describes it with the helper text, prefilled with the record's email", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Give access to the app" })).toBeTruthy();
    const field = within(dialog).getByLabelText("Email address") as HTMLInputElement;
    expect(field.value).toBe("renter@example.test");
    const help = document.getElementById(field.getAttribute("aria-describedby")!.split(" ")[0]);
    expect(help?.textContent).toContain("there is no password");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("posts the trimmed address and says the notice was sent", async () => {
    renderSection({ suggestedEmail: null });
    const dialog = await giveAccess(
      "  New.Renter@Example.TEST ",
      jsonResponse(201, { access_id: ENTRY.accessId, email: "new.renter@example.test", email_sent: true })
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(dialog.isConnected).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(`/api/tenants/${TENANT_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "New.Renter@Example.TEST" }),
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Access given");
    expect(banner.textContent).toContain("new.renter@example.test can now sign in. MGM sent them a notice.");
  });

  it("tells the manager where the tenant signs in when the notice was not sent", async () => {
    renderSection();
    await giveAccess(
      "renter@example.test",
      jsonResponse(201, { access_id: ENTRY.accessId, email: "renter@example.test", email_sent: false })
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Access given, but the notice was not sent");
    expect(banner.textContent).toContain(
      "Tell renter@example.test to go to https://mgm.example.test/login and choose “Email me a sign-in link” with this address."
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("names the sign-in page without an address when MGM's address is unknown", async () => {
    renderSection({ loginUrl: null });
    await giveAccess(
      "renter@example.test",
      jsonResponse(201, { access_id: ENTRY.accessId, email: "renter@example.test", email_sent: false })
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain(
      "Tell renter@example.test to open MGM's sign-in page and choose “Email me a sign-in link” with this address."
    );
    expect(banner.textContent).not.toContain("http");
  });

  it("shows the server's answer in the dialog and marks the field on a refusal about the address", async () => {
    renderSection();
    const dialog = await giveAccess(
      "renter@example.test",
      jsonResponse(409, {
        error: "renter@example.test can already sign in to this unit.",
        code: "already_has_access",
        field: "email",
      })
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("renter@example.test can already sign in to this unit.");
    const field = within(dialog).getByLabelText("Email address");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not mark the field for a refusal that is not about the address", async () => {
    renderSection();
    const dialog = await giveAccess(
      "renter@example.test",
      jsonResponse(503, { error: "Could not give access. Retry the request.", code: "tenant_access_unavailable" })
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Could not give access. Retry the request.");
    expect(within(dialog).getByLabelText("Email address").getAttribute("aria-invalid")).toBeNull();
  });

  it("lets the address wrap in the outcome banner and in the dialog's error", async () => {
    const long = "janenakatomukasa.tenant.unit4b@examplepropertyco.example.test";
    renderSection({ loginUrl: null });
    const dialog = await giveAccess(
      long,
      jsonResponse(409, { error: `${long} can already sign in to this unit.`, code: "already_has_access", field: "email" })
    );
    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText(`${long} can already sign in to this unit.`).className).toContain("break-words");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await giveAccess(long, jsonResponse(201, { access_id: ENTRY.accessId, email: long, email_sent: true }));
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText(long).className).toContain("break-all");
  });

  it("moves focus to the outcome after a grant, and to the heading after Cancel", async () => {
    renderSection();
    await giveAccess(
      "renter@example.test",
      jsonResponse(201, { access_id: ENTRY.accessId, email: "renter@example.test", email_sent: false })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const outcome = screen.getByTestId("access-outcome");
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(outcome.textContent).toContain("Access given, but the notice was not sent");

    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "App access" }))
    );
  });

  it("asks for an address before posting an empty one", async () => {
    renderSection({ suggestedEmail: null });
    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Give access" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Enter an email address.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TenantAccessSection: Remove", () => {
  async function openRemove() {
    renderSection({ entries: [ENTRY, SECOND] });
    fireEvent.click(screen.getByRole("button", { name: "Remove access for renter@example.test" }));
    return screen.findByRole("alertdialog");
  }

  it("asks in a destructive confirmation that says access can be given again", async () => {
    const dialog = await openRemove();
    expect(within(dialog).getByText("Remove access", { selector: "span" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("Irreversible action");
    expect(within(dialog).getByRole("heading", { name: "Remove this person's access?" })).toBeTruthy();
    expect(dialog.textContent).toMatch(
      /renter@example\.test\s+will no longer see this unit's electricity use, from now on, even if they are signed in right now\.\s+Their MGM sign-in account is kept, and you can give access again at any time\./
    );
  });

  it("keeps the address out of the title and lets it wrap in the description, so 360 px does not scroll sideways", async () => {
    const dialog = await openRemove();
    const heading = within(dialog).getByRole("heading");
    expect(heading.textContent).not.toContain("@");
    const address = within(dialog).getByText("renter@example.test");
    expect(address.className).toContain("break-all");
    // The description is still what the dialog announces on open.
    const describedBy = dialog.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.contains(address)).toBe(true);
  });

  it("removes the access and refreshes the list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(`/api/tenants/${TENANT_ID}/access/${ENTRY.accessId}`, {
      method: "DELETE",
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes without an error when the access is already gone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: "This address no longer has access to this unit.", code: "access_not_found" })
    );
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the server's error with Retry, and stays open, when the removal fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: "Could not remove access. Retry the request.", code: "tenant_access_failed" })
    );
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));

    expect(await within(dialog).findByText("Could not remove access. Retry the request.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("shows readable copy with Retry when the request cannot reach MGM", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));

    expect(
      await within(dialog).findByText("Could not reach MGM. Check your connection and retry.")
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("Failed to fetch");
    expect(within(dialog).getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("clears the Access given banner for the address it removes, and keeps one for another", async () => {
    renderSection({ entries: [ENTRY, SECOND] });
    await giveAccess(
      ENTRY.email,
      jsonResponse(201, { access_id: ENTRY.accessId, email: ENTRY.email, email_sent: true })
    );
    expect((await screen.findByRole("status")).textContent).toContain("Access given");

    // Removing someone else leaves the banner in place.
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));
    fireEvent.click(screen.getByRole("button", { name: `Remove access for ${SECOND.email}` }));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain(`${ENTRY.email} can now sign in`);

    // Removing the address it names takes it away, on a 404 as on a 204.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: "This address no longer has access to this unit.", code: "access_not_found" })
    );
    fireEvent.click(screen.getByRole("button", { name: `Remove access for ${ENTRY.email}` }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/can now sign in/)).toBeNull();
  });

  it("moves focus to the section's heading after a removal and announces it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const heading = screen.getByRole("heading", { name: "App access" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Access removed for renter@example.test.");
  });

  it("never uses the browser's confirm()", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    renderSection({ entries: [ENTRY] });
    fireEvent.click(screen.getByRole("button", { name: "Remove access for renter@example.test" }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
