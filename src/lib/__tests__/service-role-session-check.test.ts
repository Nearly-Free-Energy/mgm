/**
 * Which pages and routes go beyond what the caller's own token grants, and
 * why each one is safe.
 *
 * Middleware verifies only the access token's signature and expiry
 * (getClaims), and a session signed out elsewhere still passes that until
 * its token expires. Anything that reaches the service role or a stored
 * credential therefore has to settle the session itself. Each such file is
 * one of:
 *   - "session": asks Supabase Auth with getUser(), directly or through a
 *     helper that does (currentUser*, authorizeOrganization, or a composer
 *     that runs it), before the privileged call;
 *   - "public": serves callers with no MGM session by design and has its
 *     own gate, which the reason names;
 *   - "unreleased": middleware answers 404 before any session check
 *     (src/lib/mgm/released-routes.ts). Releasing it means moving it to
 *     "session" or "public" first.
 *
 * The test finds every src/app file that imports a privileged module and
 * fails until the file is listed here with a reason a reviewer can check.
 * It checks that a "session" file calls one of the session checks, that a
 * "public" path gets through middleware without a session, and that an
 * "unreleased" path is refused. It does not prove the check comes first;
 * the reason says where it is. If middleware goes back to getUser(), the
 * "session" entries stop being the only line of defence, but the list stays
 * true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "src");

/** Modules that reach the service role or a stored credential. */
const PRIVILEGED_MODULES: Record<string, string> = {
  "@/lib/supabase/service": "The service-role client, which bypasses RLS.",
  "@/lib/openems/config": "Decrypts stored OpenEMS credentials on the service role.",
  "@/lib/mgm/organization-exists": "Counts organizations on the service role.",
  "@/lib/internal-auth": "Resolves organization API tokens on the service role.",
};

/** Named imports that are privileged although their module is not. */
const PRIVILEGED_NAMES: Record<string, string[]> = {
  "@/lib/payments/compose": ["composePaymentsPublic"],
};

/**
 * src/lib modules that import the service client without being in
 * PRIVILEGED_MODULES, each with why its callers cannot reach the service
 * role before a session check.
 */
const SERVICE_ROLE_BEHIND_A_CHECK: Record<string, string> = {
  "src/lib/payments/compose.ts":
    "composePayments runs authorizeOrganization (getUser) before it builds the service-role repository; composePaymentsPublic is listed in PRIVILEGED_NAMES.",
  "src/lib/payments/infrastructure/supabase-repository.ts":
    "Built only by src/lib/payments/compose.ts.",
};

/** Calls that ask Supabase Auth about the session (getUser) or wrap one that does. */
const SESSION_CHECKS = new Set([
  "getUser",
  "currentUserIsSuperAdmin",
  "currentUserCanAccessOrg",
  "currentUserCanAccessCommunity",
  "currentUserCanAccessMicrogrid",
  "authorizeOrganization",
  "composeBilling",
  "composeCommunityManagement",
  "composeMetering",
  "composePayments",
  // The request-scoped helpers in src/lib/auth/request-access.ts, added by
  // mgm#89, which read getUser() once per render. Drop these if that file
  // does not land.
  "getRequestUserAccess",
  "requestUserIsSuperAdmin",
  "requestUserCanAccessMicrogrid",
]);

type Entry =
  | { kind: "session"; reason: string }
  | { kind: "public"; path: string; reason: string }
  | { kind: "unreleased"; path: string; reason: string };

const ENTRIES: Record<string, Entry> = {
  // ── Pages and layouts ────────────────────────────────────────────────────
  "src/app/(dashboard)/layout.tsx": {
    kind: "session",
    reason:
      "getUser() redirects to /login; organizationExists() tells only whether any organization exists, so it may run alongside.",
  },
  "src/app/setup/page.tsx": {
    kind: "session",
    reason: "getUser() redirects to /login before organizationExists().",
  },
  "src/app/(dashboard)/communities/[id]/invoice/page.tsx": {
    kind: "session",
    reason:
      "currentUserCanAccessCommunity calls notFound() before the service-role logo read.",
  },
  "src/app/(dashboard)/microgrids/[id]/(overview)/page.tsx": {
    kind: "session",
    reason: "getMicrogridEmsConfig waits for currentUserCanAccessMicrogrid.",
  },
  "src/app/(dashboard)/microgrids/[id]/setup/edges/page.tsx": {
    kind: "session",
    reason: "getMicrogridEmsConfig waits for currentUserCanAccessMicrogrid.",
  },
  "src/app/(dashboard)/microgrids/[id]/setup/edges/[edgeId]/page.tsx": {
    kind: "session",
    reason: "getMicrogridEmsConfig waits for currentUserCanAccessMicrogrid.",
  },
  "src/app/(dashboard)/microgrids/[id]/setup/openems-backend/page.tsx": {
    kind: "session",
    reason:
      "currentUserCanAccessMicrogrid calls notFound() before getEmsSecretForMicrogrid.",
  },
  "src/app/payment/callback/page.tsx": {
    kind: "public",
    path: "/payment/callback",
    reason:
      "The provider's customer redirect; the order reference must match a stored attempt and the provider confirms the status server-side.",
  },

  // ── Released API routes ──────────────────────────────────────────────────
  "src/app/api/mgm/bootstrap/route.ts": {
    kind: "session",
    reason:
      "getUser() answers 401 before the service-role bootstrap RPC (after the bootstrap token check).",
  },
  "src/app/api/users/invite/route.ts": {
    kind: "session",
    reason:
      "currentUserIsSuperAdmin or currentUserCanAccessOrg answers 403 before the Auth admin invite.",
  },
  "src/app/api/users/[id]/resend-invite/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before any Auth admin call.",
  },
  "src/app/api/microgrids/[id]/openems-backend/route.ts": {
    kind: "session",
    reason:
      "currentUserCanAccessMicrogrid answers 404 before any stored secret is decrypted.",
  },
  "src/app/api/microgrids/[id]/openems-backend/discover/route.ts": {
    kind: "session",
    reason: "currentUserCanAccessMicrogrid answers 403 before getMicrogridEmsConfig.",
  },
  "src/app/api/microgrids/[id]/openems-backend/test/route.ts": {
    kind: "session",
    reason: "composeMetering answers 401 or 403 before getMicrogridEmsConfig.",
  },
  "src/app/api/edges/[id]/discover-devices/route.ts": {
    kind: "session",
    reason: "currentUserCanAccessMicrogrid answers 404 before getMicrogridEmsConfig.",
  },
  "src/app/api/billing-periods/[periodId]/export-csv/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before the service client is created.",
  },
  "src/app/api/billing-line-items/[lineItemId]/pdf/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before any read, the service-role logo read included.",
  },
  "src/app/api/communities/[id]/invoice-logo/route.ts": {
    kind: "session",
    reason: "currentUserCanAccessOrg answers 403 before the service-role storage write.",
  },
  "src/app/api/communities/[id]/invoice-preview/route.ts": {
    kind: "session",
    reason: "currentUserCanAccessOrg answers 403 before the service-role logo read.",
  },
  "src/app/api/organizations/[id]/payment-accounts/route.ts": {
    kind: "session",
    reason: "currentUserCanAccessOrg answers 403 before the service client is used.",
  },
  "src/app/api/payments/attempts/[id]/refresh/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before the service-role attempt lookup.",
  },
  "src/app/api/payments/attempts/[id]/reconcile/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before the service-role attempt lookup.",
  },
  "src/app/api/billing-line-items/[lineItemId]/pay/route.ts": {
    kind: "public",
    path: "/api/billing-line-items/12345678-1234-1234-1234-123456789012/pay",
    reason:
      "The customer's payment redirect; the line-item id is the bearer token, with a UUID check and a per-IP rate limit.",
  },
  "src/app/p/[slug]/route.ts": {
    kind: "public",
    path: "/p/Kp9XrA",
    reason: "The short payment link; the slug is the bearer token and must match its format.",
  },
  "src/app/api/payments/ipn/route.ts": {
    kind: "public",
    path: "/api/payments/ipn",
    reason:
      "The provider's server-to-server notification; the status is always confirmed with the provider before anything is recorded.",
  },
  "src/app/api/payments/reconcile-worker/route.ts": {
    kind: "public",
    path: "/api/payments/reconcile-worker",
    reason: "The scheduled retry worker; it requires the worker secret header.",
  },

  // ── Unreleased routes (404 in middleware) ────────────────────────────────
  "src/app/api/openems/status/route.ts": {
    kind: "unreleased",
    path: "/api/openems/status",
    reason: "Decrypts after gateRoute only; needs a getUser-backed check before release.",
  },
  "src/app/api/openems/channels/route.ts": {
    kind: "unreleased",
    path: "/api/openems/channels",
    reason: "Decrypts after gateRoute only; needs a getUser-backed check before release.",
  },
  "src/app/api/openems/energy/route.ts": {
    kind: "unreleased",
    path: "/api/openems/energy",
    reason: "Decrypts after gateRoute only; needs a getUser-backed check before release.",
  },
  "src/app/api/org-api-tokens/route.ts": {
    kind: "unreleased",
    path: "/api/org-api-tokens",
    reason: "Organization API tokens are not released.",
  },
  "src/app/api/org-api-tokens/[id]/regenerate/route.ts": {
    kind: "unreleased",
    path: "/api/org-api-tokens/token-1/regenerate",
    reason: "Organization API tokens are not released.",
  },
  "src/app/api/v1/billing-periods/route.ts": {
    kind: "unreleased",
    path: "/api/v1/billing-periods",
    reason: "The token-authenticated v1 API is not released.",
  },
  "src/app/api/v1/billing/generate/route.ts": {
    kind: "unreleased",
    path: "/api/v1/billing/generate",
    reason: "The token-authenticated v1 API is not released.",
  },
  "src/app/api/v1/microgrids/route.ts": {
    kind: "unreleased",
    path: "/api/v1/microgrids",
    reason: "The token-authenticated v1 API is not released.",
  },
  "src/app/api/v1/microgrids/[microgrid_id]/households/route.ts": {
    kind: "unreleased",
    path: "/api/v1/microgrids/grid-1/households",
    reason: "The token-authenticated v1 API is not released.",
  },
};

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Module specifiers a file imports, statically or with import(), and the names it takes. */
function imports(source: ts.SourceFile): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (specifier: string, names: string[]) => {
    const set = found.get(specifier) ?? new Set<string>();
    names.forEach((name) => set.add(name));
    found.set(specifier, set);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const names =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
          : ["*"];
      add(node.moduleSpecifier.text, names);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text, ["*"]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Names of the functions and methods a file calls. */
function calls(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isPrivileged(found: Map<string, Set<string>>): boolean {
  for (const [specifier, names] of found) {
    if (specifier in PRIVILEGED_MODULES) return true;
    const privilegedNames = PRIVILEGED_NAMES[specifier] ?? [];
    if (privilegedNames.some((name) => names.has(name) || names.has("*"))) return true;
  }
  return false;
}

describe("pages and routes that reach the service role or a stored credential", () => {
  const appFiles = sourceFiles(path.join(SRC, "app"));
  const privileged = appFiles
    .filter((file) => isPrivileged(imports(parse(file))))
    .map(relative)
    .sort();

  it("are each listed with the reason they are safe", () => {
    expect(privileged).toEqual(Object.keys(ENTRIES).sort());
  });

  it.each(
    Object.entries(ENTRIES).filter(([, entry]) => entry.kind === "session")
  )("%s asks Auth about the session", (file) => {
    const called = calls(parse(path.join(REPO_ROOT, file)));
    expect([...called].filter((name) => SESSION_CHECKS.has(name))).not.toEqual([]);
  });

  it("are reached in src/lib only through the listed modules", () => {
    const serviceImporters = sourceFiles(path.join(SRC, "lib"))
      .filter((file) => imports(parse(file)).has("@/lib/supabase/service"))
      .map(relative)
      .sort();
    const listed = [
      ...Object.keys(PRIVILEGED_MODULES)
        .filter((specifier) => specifier !== "@/lib/supabase/service")
        .map((specifier) => `src/${specifier.slice(2)}.ts`),
      ...Object.keys(SERVICE_ROLE_BEHIND_A_CHECK),
    ].sort();
    expect(serviceImporters).toEqual(listed);
  });
});

// The middleware half: public entries get through with no session, and
// unreleased entries are refused before any session check.
const getClaimsMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: getClaimsMock } }),
}));

beforeEach(() => {
  getClaimsMock.mockResolvedValue({ data: null, error: null });
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function middlewareStatus(pathname: string) {
  vi.resetModules();
  const { middleware } = await import("../../middleware");
  const res = await middleware(new NextRequest(`http://localhost${pathname}`));
  return { status: res.status, location: res.headers.get("location") };
}

describe("middleware treatment of the listed paths", () => {
  it.each(
    Object.entries(ENTRIES).flatMap(([file, entry]) =>
      entry.kind === "public" ? [[file, entry.path] as const] : []
    )
  )("%s (%s) is reachable without a session", async (_file, pathname) => {
    expect(await middlewareStatus(pathname)).toEqual({ status: 200, location: null });
  });

  it.each(
    Object.entries(ENTRIES).flatMap(([file, entry]) =>
      entry.kind === "unreleased" ? [[file, entry.path] as const] : []
    )
  )("%s (%s) is not released", async (_file, pathname) => {
    expect((await middlewareStatus(pathname)).status).toBe(404);
  });
});
