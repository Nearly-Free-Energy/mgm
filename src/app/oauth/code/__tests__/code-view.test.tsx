// @vitest-environment jsdom
/**
 * The sign-in code page (#271, ADR-008 decision 3): one string with the
 * state and the code, the query taken off the address bar, the warning, and
 * what it shows for a refusal or a link that is not whole.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeView } from "../code-view";

const STATE = "q2Yb3uXk0Jp7_rW-9aLmZtVnE4sHdFcG1oPiKyUw8xQ";
const CODE = "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function openAt(search: string) {
  window.history.replaceState(null, "", `/oauth/code${search}`);
  render(<CodeView />);
}

describe("CodeView", () => {
  it("shows one string with the state and the code, and takes the query off the address bar", async () => {
    openAt(`?code=${CODE}&state=${STATE}`);
    expect((await screen.findByLabelText("Sign-in code")).textContent).toBe(`${STATE}.${CODE}`);
    expect(window.location.pathname).toBe("/oauth/code");
    expect(window.location.search).toBe("");
    expect(document.body.textContent).toContain("Paste it only into the terminal that asked for it");
  });

  it("copies the string", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openAt(`?code=${CODE}&state=${STATE}`);
    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${STATE}.${CODE}`));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says to select the code when the browser does not allow copying", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    openAt(`?code=${CODE}&state=${STATE}`);
    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(await screen.findByText(/Select the code and copy it/)).toBeTruthy();
  });

  it.each([
    ["a refused sign-in", "?error=access_denied&state=" + STATE, /refused/],
    ["another error", "?error=server_error&error_description=Click%20evil.example", /did not finish/],
    ["no code", `?state=${STATE}`, /incomplete/],
    ["a code of the wrong shape", `?code=abc&state=${STATE}`, /incomplete/],
    ["a state of the wrong shape", `?code=${CODE}&state=short`, /incomplete/],
    ["nothing (a reload after the code was shown)", "", /incomplete/],
  ])("shows no code for %s", async (_name, search, message) => {
    openAt(search);
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(screen.queryByLabelText("Sign-in code")).toBeNull();
    expect(document.body.textContent).not.toContain("evil.example");
    expect(window.location.search).toBe("");
  });
});
