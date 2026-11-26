import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { APPROVALS_ROUTE, CODE_PATH, CONSENT_PATH } from "@/lib/auth/client-consent";
import { decodePastedCode } from "@/lib/auth/pasted-code";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { LOCAL_SUPABASE_URL, mintServiceRoleJwt, serviceClient, testAnonKey } from "../src/lib/supabase/__tests__/rls.helpers";
import { checkNarrowPage, watchPage } from "./checks";

// A client sign-in through MGM's consent and code pages (#271, ADR-008
// decisions 2 and 3) on a 360 px touch screen, run twice: signed in as the
// smoke's organization manager (the narrow project) and as its tenant, whose
// rows are all tenant rows (the tenant project; playwright.config.ts). The
// spec registers a client of its own with Supabase Auth, whose one return
// address is this server's code page, and lists it in mgm_clients, as
// docs/setup.md registers the CLI. It does what `mgm login` will: starts the
// authorize request with PKCE, opens the consent page Supabase Auth names,
// and exchanges the string the code page shows. Connect's record is the one
// write the pages make.
//
// The pages and the approvals route answer 404 until a release lists them
// in src/lib/mgm/released-routes.ts, so this spec is skipped until then and
// runs by itself in the release that lists all three.

const RELEASED = [CONSENT_PATH, CODE_PATH, APPROVALS_ROUTE].every((path) => isReleasedRoute(path));
test.skip(!RELEASED, "the consent and code pages are not released yet (src/lib/mgm/released-routes.ts)");

const LABEL = "Smoke CLI";
const APPROVALS = new RegExp(`^${APPROVALS_ROUTE}$`);

let clientId = "";
let redirectUri = "";

async function adminAuth(method: string, path: string, json?: object) {
  const key = await mintServiceRoleJwt();
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** What `mgm login` does first: the authorize request, with PKCE and a state of its own. */
async function startLogin() {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    scope: "email",
  });
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/authorize?${query}`, {
    headers: { apikey: testAnonKey()! },
    redirect: "manual",
  });
  expect(res.status, await res.text()).toBeGreaterThanOrEqual(300);
  // Supabase Auth names the consent page under its site_url; this server is
  // on another port, so only the path and the id are taken.
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe(CONSENT_PATH);
  const authorizationId = location.searchParams.get("authorization_id");
  expect(authorizationId).toBeTruthy();
  return { verifier, state, consent: `${CONSENT_PATH}?${new URLSearchParams({ authorization_id: authorizationId! })}` };
}

test.beforeAll(async () => {
  const { project } = test.info();
  redirectUri = `${new URL(String(project.use.baseURL)).origin}${CODE_PATH}`;
  const created = await adminAuth("POST", "/admin/oauth/clients", {
    client_name: `mgm-smoke-${project.name}`,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  clientId = created.body.client_id as string;
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind: "operator", label: LABEL });
  expect(error).toBeNull();
});

test.afterAll(async () => {
  if (!clientId) return;
  // The person's approval records go with the client (ON DELETE CASCADE).
  const svc = await serviceClient();
  await svc.from("mgm_clients").delete().eq("client_id", clientId);
  await adminAuth("DELETE", `/admin/oauth/clients/${clientId}`);
});

test("a client sign-in through the consent and code pages at 360 px", async ({ page }) => {
  const watch = await watchPage(page, { expectedWrites: [APPROVALS] });

  // The question: the client, its kind, the warning, and two 44 px answers.
  const first = await startLogin();
  await page.goto(first.consent);
  await expect(page.getByRole("heading", { name: `Connect ${LABEL}?` })).toBeVisible();
  await expect(page.getByText("Command line", { exact: true })).toBeVisible();
  await expect(page.getByText("Did you run mgm login just now?")).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });

  // Connect records the approval, and the browser lands on the code page,
  // which takes the code off the address bar.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForURL((url) => url.pathname === CODE_PATH);
  const shown = page.getByLabel("Sign-in code");
  await expect(shown).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await expect(page.getByText("Paste it only into the terminal that asked for it")).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });

  // The string the person pastes gets the CLI its token.
  const pasted = decodePastedCode((await shown.textContent()) ?? "");
  expect(pasted?.state).toBe(first.state);
  const token = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { apikey: testAnonKey()!, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: pasted!.code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: first.verifier,
    }),
  });
  const body = (await token.json()) as { access_token?: string };
  expect(token.status, JSON.stringify(body)).toBe(200);
  const claims = JSON.parse(Buffer.from(body.access_token!.split(".")[1], "base64url").toString("utf8"));
  expect(claims).toMatchObject({ client_id: clientId, mgm_client_kind: "operator" });

  // A second sign-in of the same client, which Supabase Auth would approve
  // without asking, still gets the question; Don't connect asks nobody.
  const second = await startLogin();
  await page.goto(second.consent);
  await expect(page.getByRole("heading", { name: `Connect ${LABEL}?` })).toBeVisible();
  await expect(page.getByText("Did you run mgm login just now?")).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });
  await page.getByRole("button", { name: "Don't connect" }).click();
  await expect(page.getByRole("heading", { name: "Not connected" })).toBeVisible();
  await checkNarrowPage(page, { landmarks: false });

  // A sign-in MGM cannot find shows a refusal and a way back, and no question.
  await page.goto(`${CONSENT_PATH}?authorization_id=${"A".repeat(32)}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("could not find this sign-in");
  await expect(page.getByRole("link", { name: "Go to MGM" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await checkNarrowPage(page, { landmarks: false });

  // The code page with nothing in its address, as after a reload.
  await page.goto(CODE_PATH);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("incomplete");
  await expect(page.getByLabel("Sign-in code")).toHaveCount(0);
  await checkNarrowPage(page, { landmarks: false });

  watch.assertClean();
});
