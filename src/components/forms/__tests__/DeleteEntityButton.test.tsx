// @vitest-environment jsdom
//
// DeleteEntityButton preview-error reporting.
//
// Cases:
//   (a) Without onPreviewError, a failed preview renders the inline banner.
//   (b) With onPreviewError, the message goes to the callback and no inline
//       banner renders; a new attempt first reports null.
//   (c) A preview refused because the entity holds kept billing (409) shows
//       the reason and opens no dialog.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { DeleteEntityButton } from "../DeleteEntityButton";

const EDGE_ID = "11111111-1111-4111-8111-111111111111";

function stubPreviewFailure() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "Edge not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeleteEntityButton preview errors", () => {
  it("(a) renders the inline banner when no onPreviewError is given", async () => {
    const fetchMock = stubPreviewFailure();
    render(<DeleteEntityButton entity="edge" id={EDGE_ID} name="Pi" />);

    fireEvent.click(screen.getByRole("button", { name: /delete edge/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Edge not found.");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/edges/${EDGE_ID}/delete-preview`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("(b) reports the error to onPreviewError instead of rendering it", async () => {
    stubPreviewFailure();
    const onPreviewError = vi.fn();
    render(
      <DeleteEntityButton
        entity="edge"
        id={EDGE_ID}
        name="Pi"
        onPreviewError={onPreviewError}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /delete edge/i }));

    await waitFor(() =>
      expect(onPreviewError).toHaveBeenLastCalledWith("Edge not found.")
    );
    expect(onPreviewError).toHaveBeenNthCalledWith(1, null);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("(c) shows why a microgrid with kept billing cannot be deleted, and opens no dialog", async () => {
    const reason =
      "This microgrid has 2 closed billing periods. Closed billing and billing with recorded payments are kept, so this microgrid cannot be deleted.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: reason }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      )
    );
    render(<DeleteEntityButton entity="microgrid" id={EDGE_ID} name="Kiwafu" />);

    fireEvent.click(screen.getByRole("button", { name: /delete microgrid/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(reason);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
