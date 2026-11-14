/**
 * Which pages and routes go beyond what the caller's own token grants, and
 * why each one is safe.
 *
 * Middleware verifies only the access token's signature and expiry
 * (getClaims), and a session signed out elsewhere still passes that until
 * its token expires. Anything that reaches the service role or a stored
 * credential therefore has to settle the session itself. Each such src/app
 * file is one of:
 *   - "session": asks Supabase Auth with getUser(), directly or through a
 *     helper that does (currentUser*, authorizeOrganization, or a composer
 *     that runs it), before the privileged call;
 *   - "public": serves callers with no MGM session by design and has its
 *     own gate, which the reason names;
 *   - "unreleased": middleware answers 404 before any session check
 *     (src/lib/mgm/released-routes.ts). Releasing it means moving it to
 *     "session" or "public" first.
 *
 * "Reaches" follows the whole import graph of src/: `@/` and relative
 * imports, re-exports and import() are resolved, and type-only imports are
 * skipped. A file is privileged if it imports a privileged module, imports a
 * privileged export of another privileged file, or names a privileged
 * registry, which code reaches by name rather than by import. Every
 * privileged file outside src/app is listed in MODULES with the exports that
 * pass the privilege on, so a new indirect path fails here until someone has
 * decided what its importers inherit. A module that settles the session
 * before anything privileged passes nothing on through the export that does
 * so; session-ended-elsewhere.test.ts checks that the composers listed that
 * way refuse a session Auth has ended before they open a scope.
 *
 * The test fails until every privileged src/app file is listed in ENTRIES
 * with a reason a reviewer can check. It checks that a "session" file calls
 * one of the session checks, that a "public" path gets through middleware
 * without a session, and that an "unreleased" path is refused. It does not
 * prove the check comes first; the reason says where it is. If middleware
 * goes back to getUser(), the "session" entries stop being the only line of
 * defence, but the lists stay true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "src");

/** Modules that reach the service role or a stored credential themselves. */
const PRIVILEGED_MODULES: Record<string, string> = {
  "src/lib/supabase/service.ts": "The service-role client, which bypasses RLS.",
  "src/lib/openems/config.ts": "Decrypts stored OpenEMS credentials on the service role.",
  "src/lib/mgm/organization-exists.ts": "Counts organizations on the service role.",
  "src/lib/internal-auth.ts": "Resolves organization API tokens on the service role.",
};

/**
 * Root registries through which code reaches something privileged by a call
 * the import graph cannot follow. Code reaches one by name
 * (ctx.meteringProviders, an inject list, getMgmRuntime().meteringProviders),
 * so naming it is privileged. paymentProviderRegistry is not here: its
 * factories are handed a secret the payments repository has already read, and
 * read none themselves. If a payment factory starts reading credentials, add it.
 */
const PRIVILEGED_REGISTRIES: Record<string, string> = {
  meteringProviders:
    "Builds metering providers; the OpenEMS provider calls getMicrogridEmsConfig when it reads.",
  mgmSurface:
    "Holds contributed loaders, signals, search and prepare functions, which compose capabilities that can build credentialed providers; a call made through it cannot be followed by import, so every caller settles the session first.",
};

type Module = {
  /** The exports an importer inherits the privilege through; "all" for any import. */
  privilegedExports: "all" | readonly string[];
  reason: string;
};

/** Privileged files outside src/app, and what their importers inherit. */
const MODULES: Record<string, Module> = {
  "src/lib/metering/openems-provider.ts": {
    privilegedExports: "all",
    reason: "Builds the OpenEMS provider, which calls getMicrogridEmsConfig when it reads.",
  },
  "src/lib/metering/infrastructure/openems-connection.ts": {
    privilegedExports: "all",
    reason: "Calls getMicrogridEmsConfig for connection tests and edge discovery.",
  },
  "src/lib/metering/index.ts": {
    privilegedExports: "all",
    reason: "Re-exports the OpenEMS provider.",
  },
  "src/lib/metering/providers-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the OpenEMS factory into meteringProviders; the factory runs only through that registry, which is tracked by name.",
  },
  "src/lib/metering/fixture/plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the synthetic factory into meteringProviders when MGM_METERING_FIXTURES is on; the factory reads no credentials and runs only through that registry, which is tracked by name.",
  },
  "src/lib/organization-directory/surface-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the plugin's GUI contribution on mgmSurface; anything the contribution runs is called only through that registry, which is tracked by name.",
  },
  "src/lib/community-management/surface-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the plugin's GUI contribution on mgmSurface; anything the contribution runs is called only through that registry, which is tracked by name.",
  },
  "src/lib/metering/surface-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the plugin's GUI contribution on mgmSurface; anything the contribution runs is called only through that registry, which is tracked by name.",
  },
  "src/lib/billing/surface-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the plugin's GUI contribution on mgmSurface; anything the contribution runs is called only through that registry, which is tracked by name.",
  },
  "src/lib/payments/surface-plugin.ts": {
    privilegedExports: [],
    reason:
      "Registers the plugin's GUI contribution on mgmSurface; anything the contribution runs is called only through that registry, which is tracked by name.",
  },
  "src/lib/metering/compose.ts": {
    privilegedExports: ["MeteringPlugin"],
    reason:
      "composeMetering runs authorizeOrganization (getUser) before it opens a scope; MeteringPlugin builds providers in whatever scope loads it.",
  },
  "src/lib/billing/compose.ts": {
    privilegedExports: ["BillingPlugin"],
    reason:
      "composeBilling runs authorizeOrganization (getUser) before it opens a scope, readOnly or not; BillingPlugin builds a provider in whatever scope loads it.",
  },
  "src/lib/cordis/billing-review.ts": {
    privilegedExports: ["composeBillingReview", "BillingReviewPlugin"],
    reason: "composeBillingReview checks no session, so its callers must.",
  },
  "src/lib/payments/compose.ts": {
    privilegedExports: ["composePaymentsPublic"],
    reason:
      "composePayments runs authorizeOrganization (getUser) before it builds the service-role repository; composePaymentsPublic serves callers with no session by design.",
  },
  "src/lib/payments/infrastructure/supabase-repository.ts": {
    privilegedExports: "all",
    reason: "Reads merchant account secrets on the service role.",
  },
  "src/lib/gui/host/server/snapshot.ts": {
    privilegedExports: ["surfaceSnapshot"],
    reason:
      "Names mgmSurface: the host's one read of the registry. Its importers settle the session before they call what the snapshot holds.",
  },
  "src/lib/gui/host/server/view.ts": {
    privilegedExports: ["dispatchView"],
    reason:
      "Runs a contributed view's loader from the snapshot. dispatchView takes a HostContext, which hostContext issues only from a getUser()-backed access read.",
  },
  "src/lib/gui/host/server/prepare.ts": {
    privilegedExports: ["prepareAction"],
    reason:
      "Runs a contributed action's available() and prepare from the snapshot. prepareAction takes a HostContext, which hostContext issues only from a getUser()-backed access read.",
  },
  "src/lib/gui/host/server/signals.ts": {
    privilegedExports: ["collectSignals"],
    reason:
      "Reads the snapshot and runs contributed watchers from it. collectSignals takes a HostContext, which hostContext issues only from a getUser()-backed access read. collectStatus runs only the status entries its caller passes.",
  },
  "src/lib/gui/host/server/search.ts": {
    privilegedExports: ["runSearch"],
    reason:
      "Reads the snapshot and runs contributed searches from it. runSearch takes a HostContext, which hostContext issues only from a getUser()-backed access read.",
  },
  "src/lib/gui/host/server/manifest.ts": {
    privilegedExports: ["buildManifest", "getManifest", "preloadManifest"],
    reason:
      "Reads the snapshot and runs contributed status loaders from it. buildManifest takes a HostContext, which hostContext issues only from a getUser()-backed access read; getManifest and preloadManifest read the session with getRequestUserAccess first. All three are listed, so a page that imports any of them is itself listed.",
  },
  "src/lib/gui/host/server/go.ts": {
    privilegedExports: ["resolveGoTarget"],
    reason:
      "Reads the manifest with getManifest, which reads the session with getRequestUserAccess first. goTarget only reads a manifest it is handed.",
  },
  "src/lib/runtime/root.ts": {
    privilegedExports: [],
    reason:
      "Creates the registries and hands them out on getMgmRuntime(); every reader names meteringProviders or mgmSurface and is tracked.",
  },
  "src/lib/runtime/services.ts": {
    privilegedExports: [],
    reason:
      "Declares the metering registry's class and the service types, including mgmSurface's; an instance builds nothing until a plugin registers into it.",
  },
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
  // src/lib/auth/access.ts: getUser() and the caller's role rows.
  "getCurrentUserAccess",
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
  "src/app/(gui)/layout.tsx": {
    kind: "session",
    reason:
      "getUser() redirects to /login; organizationExists() tells only whether any organization exists, so it may run alongside. preloadManifest and getManifest read the session with getRequestUserAccess (getUser) before the manifest's reads.",
  },
  "src/app/(gui)/go/[nav]/page.tsx": {
    kind: "session",
    reason:
      "getRequestUserAccess (getUser) redirects to /login before resolveGoTarget, whose getManifest reads the session again before the manifest's reads.",
  },
  "src/app/setup/page.tsx": {
    kind: "session",
    reason: "getUser() redirects to /login before organizationExists().",
  },
  "src/app/(gui)/communities/[id]/invoice/page.tsx": {
    kind: "session",
    reason:
      "currentUserCanAccessCommunity calls notFound() before the service-role logo read.",
  },
  "src/app/(gui)/microgrids/[id]/setup/edges/page.tsx": {
    kind: "session",
    reason: "getMicrogridEmsConfig waits for currentUserCanAccessMicrogrid.",
  },
  "src/app/(gui)/microgrids/[id]/setup/edges/[edgeId]/page.tsx": {
    kind: "session",
    reason: "getMicrogridEmsConfig waits for currentUserCanAccessMicrogrid.",
  },
  "src/app/(gui)/microgrids/[id]/setup/openems-backend/page.tsx": {
    kind: "session",
    reason:
      "currentUserCanAccessMicrogrid calls notFound() before getEmsSecretForMicrogrid.",
  },
  "src/app/payment/callback/route.ts": {
    kind: "public",
    path: "/payment/callback",
    reason:
      "The provider's customer redirect; the order reference must match a stored attempt and the provider confirms the status server-side. For a matched attempt it also reads its community's name, its organization's name and the community's invoice branding (colour, WhatsApp number, a PNG or JPEG logo of at most 6 KB) to brand the page, with enumerated columns; an unmatched reference reads nothing more.",
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
      "currentUserCanAccessMicrogrid answers 403 before any stored secret is decrypted, and saveEmsConfigForMicrogrid asks it again before the service-role save.",
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
  "src/app/api/billing-line-items/[lineItemId]/usage/route.ts": {
    kind: "session",
    reason:
      "getUser() answers 401 and currentUserCanAccessMicrogrid 403 before meteringProviders.forRequest.",
  },
  "src/app/api/billing-review/preview/route.ts": {
    kind: "session",
    reason: "getUser() answers 401 before composeBillingReview.",
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
  "src/app/api/gui/view/route.ts": {
    kind: "session",
    reason:
      "getCurrentUserAccess (getUser) answers 401 or 403 before the snapshot is read or any loader runs.",
  },
  "src/app/api/gui/prepare/route.ts": {
    kind: "session",
    reason:
      "getCurrentUserAccess (getUser) answers 401 or 403 before the body is read, the snapshot is read or any prepare runs.",
  },
  "src/app/api/gui/signals/route.ts": {
    kind: "session",
    reason: "getCurrentUserAccess (getUser) answers 401 or 403 before the snapshot is read or any watcher runs.",
  },
  "src/app/api/gui/search/route.ts": {
    kind: "session",
    reason:
      "getCurrentUserAccess (getUser) answers 401 or 403 before the query is read, the snapshot is read or any search runs.",
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

/** Every non-test source file under src/. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [full] : [];
  });
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

/** The file an `@/` or relative specifier names, null for a package, undefined if missing. */
function resolve(from: string, specifier: string): string | null | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const found = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  return found ? relative(found) : undefined;
}

type Edge = { target: string; names: Set<string> };

/**
 * The files a file imports or re-exports at run time, statically or with
 * import(), and the names it takes from each; "*" for a namespace, a star
 * re-export or import(). A side-effect import takes no names.
 */
function edges(file: string, unresolved: string[]): Edge[] {
  const found = new Map<string, Set<string>>();
  const add = (specifier: string, names: string[]) => {
    const target = resolve(file, specifier);
    if (target === null) return;
    if (target === undefined) {
      unresolved.push(`${relative(file)}: ${specifier}`);
      return;
    }
    const set = found.get(target) ?? new Set<string>();
    names.forEach((name) => set.add(name));
    found.set(target, set);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) {
        add(node.moduleSpecifier.text, []);
      } else if (!clause.isTypeOnly) {
        const names: string[] = clause.name ? ["default"] : [];
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
          }
        }
        if (names.length > 0) add(node.moduleSpecifier.text, names);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names =
        clause && ts.isNamedExports(clause)
          ? clause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => (element.propertyName ?? element.name).text)
          : ["*"];
      if (names.length > 0) add(node.moduleSpecifier.text, names);
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
  visit(parse(file));
  return [...found].map(([target, names]) => ({ target, names }));
}

/** The privileged registries a file names, as an identifier, property or string. */
function namedRegistries(file: string): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      Object.hasOwn(PRIVILEGED_REGISTRIES, node.text)
    ) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return [...names];
}

/** Whether importing these names from a privileged file passes the privilege on. */
function inherits(target: string, names: Set<string>): boolean {
  const exports = Object.hasOwn(MODULES, target) ? MODULES[target].privilegedExports : "all";
  if (exports === "all") return true;
  return names.has("*") || exports.some((name) => names.has(name));
}

/** The privileged files under src/, by the rules in the header. */
function privilegedFiles() {
  const unresolved: string[] = [];
  const files = sourceFiles(SRC).map(relative);
  const graph = new Map(files.map((file) => [file, edges(path.join(REPO_ROOT, file), unresolved)]));
  const privileged = new Set(
    files.filter(
      (file) =>
        Object.hasOwn(PRIVILEGED_MODULES, file) ||
        namedRegistries(path.join(REPO_ROOT, file)).length > 0
    )
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, out] of graph) {
      if (privileged.has(file)) continue;
      if (out.some((edge) => privileged.has(edge.target) && inherits(edge.target, edge.names))) {
        privileged.add(file);
        grew = true;
      }
    }
  }
  return { files, privileged: [...privileged].sort(), unresolved };
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

/** Names a file exports at run time. */
function exportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (
      exported &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      statement.exportClause.elements.forEach((element) => names.add(element.name.text));
    }
  }
  return names;
}

describe("pages and routes that reach the service role or a stored credential", () => {
  const { files, privileged, unresolved } = privilegedFiles();

  it("are found through imports that all resolve", () => {
    expect(unresolved).toEqual([]);
    expect(Object.keys(PRIVILEGED_MODULES).filter((file) => !files.includes(file))).toEqual([]);
  });

  it("are each listed with the reason they are safe", () => {
    expect(privileged.filter((file) => file.startsWith("src/app/"))).toEqual(
      Object.keys(ENTRIES).sort()
    );
  });

  it("are reached outside src/app only through modules that say what their importers inherit", () => {
    expect(
      privileged.filter(
        (file) => !file.startsWith("src/app/") && !Object.hasOwn(PRIVILEGED_MODULES, file)
      )
    ).toEqual(Object.keys(MODULES).sort());
  });

  it.each(
    Object.entries(MODULES).flatMap(([file, module]) =>
      module.privilegedExports === "all" ? [] : module.privilegedExports.map((name) => [file, name] as const)
    )
  )("%s exports %s", (file, name) => {
    expect(exportedNames(parse(path.join(REPO_ROOT, file))).has(name)).toBe(true);
  });

  it.each(
    Object.entries(ENTRIES).filter(([, entry]) => entry.kind === "session")
  )("%s asks Auth about the session", (file) => {
    const called = calls(parse(path.join(REPO_ROOT, file)));
    expect([...called].filter((name) => SESSION_CHECKS.has(name))).not.toEqual([]);
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
