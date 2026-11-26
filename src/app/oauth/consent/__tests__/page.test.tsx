/**
 * /oauth/consent, the server part (#271): getUser() comes before the
 * service-role read, the read is for that user's id, and each refusal is
 * shown without the question.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  getUser: vi.fn(),
  createServiceClient: vi.fn(() => ({ service: true })),
  readClientAuthorization: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/auth/client-consent", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client-consent")>()),
  readClientAuthorization: mocks.readClientAuthorization,
}));
vi.mock("../consent-view", () => ({
  ConsentView: (props: { authorizationId: string; client: { label: string }; email: string | null }) => (
    <p>
      view {props.authorizationId} {props.client.label} {props.email}
    </p>
  ),
}));

import ClientConsentPage from "../page";

const ID = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const open = (query: Record<string, string | string[]>) => ClientConsentPage({ searchParams: Promise.resolve(query) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "renter@example.org" } } });
});

describe("/oauth/consent", () => {
  it("sends a session Supabase Auth has ended to sign in, and back here, before reading anything", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(open({ authorization_id: ID })).rejects.toThrow(
      `redirect:/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${ID}`)}`
    );
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.readClientAuthorization).not.toHaveBeenCalled();
  });

  it("reads the sign-in's client for the signed-in person and asks the question", async () => {
    mocks.readClientAuthorization.mockResolvedValue({
      outcome: "ok",
      client: { id: "c-1", kind: "operator", label: "MGM CLI" },
    });
    const html = renderToStaticMarkup((await open({ authorization_id: ID })) as ReactElement);
    expect(mocks.readClientAuthorization).toHaveBeenCalledWith({ service: true }, ID, "user-1");
    expect(html).toContain(`view ${ID} MGM CLI renter@example.org`);
  });

  it.each([
    ["no id", {}],
    ["an id of the wrong shape", { authorization_id: "x/../y" }],
    ["two ids", { authorization_id: [ID, ID] }],
  ])("says the link is incomplete for %s, and reads nothing", async (_name, query) => {
    const html = renderToStaticMarkup((await open(query)) as ReactElement);
    expect(html).toContain("This sign-in link is incomplete");
    expect(mocks.readClientAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", "could not find this sign-in"],
    ["expired", "has expired"],
    ["answered", "already been answered"],
    ["unlisted", "does not accept this app"],
  ])("shows the refusal for %s without the question", async (outcome, message) => {
    mocks.readClientAuthorization.mockResolvedValue({ outcome });
    const html = renderToStaticMarkup((await open({ authorization_id: ID })) as ReactElement);
    expect(html).toContain(message);
    expect(html).not.toContain("view ");
  });
});
