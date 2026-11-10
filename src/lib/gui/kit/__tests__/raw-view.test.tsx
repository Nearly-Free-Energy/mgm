import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KitRuntimeProvider, type KitRuntime } from "../../host/client/kit-runtime";
import { model, recordingRuntime } from "../../host/client/__tests__/kit-test-utils";
import { RawView } from "../raw-view";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null, useRouter: () => ({}) }));

describe("RawView", () => {
  it("shows what every kind shares, marked data-gui-raw, and says a newer interface is needed", async () => {
    const act = vi.fn<KitRuntime["act"]>(async () => ({ type: "result", ok: true }));
    const runtime = recordingRuntime({ act });
    const ref = { action: "billing.close" as const, params: {}, label: "Close period", enabled: true };
    const link = { id: "billing.csv" as const, label: "Export", href: "/api/billing/export" as const };
    const raw = model({ kind: "chart", title: "Chart", subtitle: "Today", actions: [ref], links: [link], notice: { tone: "warning", text: "Billing is off" } } as never);
    const { container } = render(
      <KitRuntimeProvider runtime={runtime}>
        <RawView model={raw} />
      </KitRuntimeProvider>,
    );
    expect(container.querySelector("[data-gui-raw]")?.getAttribute("data-gui-raw")).toBe("chart");
    expect(screen.getByRole("heading", { name: "Chart" })).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Billing is off");
    expect(screen.getByText("This view needs a newer interface.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Export" }));
    expect(runtime.open).toHaveBeenCalledWith(link);
    fireEvent.click(screen.getByRole("button", { name: "Close period" }));
    await waitFor(() => expect(act.mock.calls.map((call) => call[0])).toEqual([ref]));
  });
});
