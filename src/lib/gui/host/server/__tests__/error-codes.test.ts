/**
 * The described API's error codes are listed in one place (../error-codes.ts)
 * and the list says what the code answers:
 * - every `gui_` code written in the host's server modules and its routes
 *   (src/app/api/gui/) is listed, every listed one is written, and a status
 *   written beside a code, as `fail(404, "gui_not_found"` or
 *   `status: 503, code: "gui_unavailable"`, is one listed for it. A status
 *   the code takes at run time (a loader's or an action's own) is not
 *   written beside it, so its statuses are listed by hand;
 * - the gate refuses with the codes gateCode names;
 * - parseJsonBody refuses with the code BODY_CODES names, at its status.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MGM_BUNDLED_PLUGINS, getBundledPlugin } from "@/lib/plugins/bundled";
import { MgmGate } from "@/lib/runtime/gate";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { BODY_CODES, GATE_CODES, HOST_CODES, gateCode, listedCodes, type HostCode } from "../error-codes";

const REPO = path.resolve(__dirname, "../../../../../..");
const HOST_SERVER = "src/lib/gui/host/server";
const HOST_ROUTES = "src/app/api/gui";

/** Every non-test source file of the host's server side and its routes, by repository path. */
function hostSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.set(rel, readFileSync(path.join(REPO, rel), "utf8"));
      }
    }
  };
  walk(HOST_SERVER);
  walk(HOST_ROUTES);
  return out;
}

/** The `gui_` codes written as strings in `sources`, each with the files it is in. */
function writtenCodes(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [file, text] of sources) {
    for (const [, code] of text.matchAll(/"(gui_[a-z_]+)"/g)) found.set(code, [...(found.get(code) ?? []), file]);
  }
  return found;
}

/** Each status written right before a `gui_` code, as a call's argument or an object's `status`. */
function writtenStatuses(sources: ReadonlyMap<string, string>): { file: string; status: number; code: string }[] {
  const found: { file: string; status: number; code: string }[] = [];
  for (const [file, text] of sources) {
    for (const [, status, code] of text.matchAll(/\b(\d{3}),\s*(?:code:\s*)?"(gui_[a-z_]+)"/g)) {
      found.push({ file, status: Number(status), code });
    }
  }
  return found;
}

/** Problems between the list and what the sources write. */
function listProblems(
  listed: Readonly<Record<string, { status: readonly number[] }>>,
  sources: ReadonlyMap<string, string>,
): string[] {
  const written = writtenCodes(sources);
  const problems: string[] = [];
  for (const [code, files] of written) {
    if (!Object.hasOwn(listed, code)) problems.push(`${code} (written in ${files.join(", ")}) is not in HOST_CODES`);
  }
  for (const code of Object.keys(listed)) if (!written.has(code)) problems.push(`${code} is listed but written nowhere`);
  for (const { file, status, code } of writtenStatuses(sources)) {
    if (Object.hasOwn(listed, code) && !listed[code].status.includes(status)) {
      problems.push(`${file} answers ${code} with ${status}, which HOST_CODES does not list for it`);
    }
  }
  return problems.sort();
}

describe("the host's codes", () => {
  it("lists every gui_ code the host writes, at each status written beside it, and only those", () => {
    const sources = hostSources();
    expect(listProblems(HOST_CODES, sources)).toEqual([]);
    // The status check is not vacuous: the host writes most codes beside their status.
    expect(writtenStatuses(sources).length).toBeGreaterThan(Object.keys(HOST_CODES).length);
  });

  it("finds the codes and statuses it checks, in each form the host writes them", () => {
    const sources = new Map([
      ["a.ts", 'const X = fail(404, "gui_not_found", "…");\nreturn hostFailure(\n  400,\n  "gui_bad_request", m);'],
      ["b.ts", '{ ok: false, status: 503,\n  code: "gui_unavailable", message }; d.code = "gui_made_up";'],
    ]);
    expect(writtenStatuses(sources).map(({ status, code }) => `${status} ${code}`)).toEqual([
      "404 gui_not_found",
      "400 gui_bad_request",
      "503 gui_unavailable",
    ]);
    const listed = { gui_not_found: { status: [404] }, gui_bad_request: { status: [422] }, gui_unavailable: { status: [503] }, gui_spare: { status: [] } };
    expect(listProblems(listed, sources)).toEqual([
      "a.ts answers gui_bad_request with 400, which HOST_CODES does not list for it",
      "gui_made_up (written in b.ts) is not in HOST_CODES",
      "gui_spare is listed but written nowhere",
    ]);
  });

  it("gives every code a meaning, and a status or a catalog reason", () => {
    for (const [code, entry] of Object.entries(HOST_CODES) as [HostCode, (typeof HOST_CODES)[HostCode]][]) {
      expect(entry.meaning.length, code).toBeGreaterThan(0);
      expect(entry.status.length + ("reasons" in entry ? entry.reasons.length : 0), code).toBeGreaterThan(0);
      for (const status of entry.status) expect(status >= 400 && status <= 599, `${code} ${status}`).toBe(true);
    }
  });
});

describe("the gate's codes", () => {
  const gate = new MgmGate({
    plugins: MGM_BUNDLED_PLUGINS,
    get: (name) => getBundledPlugin(name),
    isCore: (name) => getBundledPlugin(name)?.core ?? false,
  });
  /** A client on which the organization resolves without a query and the plugin state reads as `answer`. */
  const client = (answer: { data: boolean | null; error: { message: string } | null }) =>
    ({ rpc: async () => answer }) as unknown as SupabaseClient;
  const ask = (plugin: (typeof MGM_BUNDLED_PLUGINS)[number]["name"], answer: Parameters<typeof client>[0]) =>
    gate.check(client(answer), { plugin, target: { kind: "organization", id: "550e8400-e29b-41d4-a716-446655440000" }, method: "POST" });

  it.each(MGM_BUNDLED_PLUGINS.filter((p) => !p.core).map((p) => p.name))("are the codes the gate refuses %s with", async (plugin) => {
    await expect(ask(plugin, { data: false, error: null })).resolves.toMatchObject({
      status: GATE_CODES.disabled.status[0],
      code: gateCode(plugin, "disabled"),
    });
    await expect(ask(plugin, { data: null, error: { message: "unreadable" } })).resolves.toMatchObject({
      status: GATE_CODES.unavailable.status[0],
      code: gateCode(plugin, "unavailable"),
    });
  });
});

describe("the body parser's code", () => {
  it("is the one parseJsonBody refuses with, at its status", async () => {
    const parsed = await parseJsonBody(new Request("http://localhost/api/x", { method: "POST", body: "{" }), z.strictObject({}));
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.response.status).toBe(BODY_CODES.invalid_body.status[0]);
    expect(await parsed.response.json()).toMatchObject({ code: "invalid_body", error: expect.any(String) });
  });
});

describe("listedCodes", () => {
  it("lists every host and body code, and the gate's codes asked for, each once and sorted", () => {
    const codes = listedCodes([
      ["billing", "disabled"],
      ["payments", "unavailable"],
      ["billing", "disabled"],
    ]).map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((c) => !Object.hasOwn(HOST_CODES, c))).toEqual(["billing_disabled", "invalid_body", "payments_gate_unavailable"]);
    expect(codes).toEqual(expect.arrayContaining(Object.keys(HOST_CODES)));
  });
});
