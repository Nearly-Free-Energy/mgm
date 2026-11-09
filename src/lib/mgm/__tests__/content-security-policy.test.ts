import { describe, expect, it } from "vitest";
import {
  CSP_MODE,
  buildContentSecurityPolicy,
  cspHeaderName,
  newNonce,
} from "../content-security-policy";

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name, values];
    }),
  );
}

describe("content security policy", () => {
  it("is report-only (decision 19 on #115)", () => {
    expect(CSP_MODE).toBe("report-only");
    expect(cspHeaderName()).toBe("content-security-policy-report-only");
    expect(cspHeaderName("enforce")).toBe("content-security-policy");
  });

  it("builds the exact directive set", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "abc123==",
      supabaseUrl: "https://db.example.test",
      development: false,
    });
    expect(directives(policy)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "'nonce-abc123=='", "'strict-dynamic'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https://db.example.test"],
      "font-src": ["'self'"],
      "connect-src": ["'self'", "https://db.example.test"],
      "form-action": ["'self'"],
      "base-uri": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "manifest-src": ["'self'"],
    });
  });

  it("uses only the origin of a Supabase URL with a path", () => {
    const policy = buildContentSecurityPolicy({
      nonce: "n",
      supabaseUrl: "https://proxy.example.test:8443/supabase/",
      development: false,
    });
    expect(directives(policy)["connect-src"]).toEqual([
      "'self'",
      "https://proxy.example.test:8443",
    ]);
    expect(policy).not.toContain("/supabase");
  });

  it("adds eval and websockets in development", () => {
    const d = directives(
      buildContentSecurityPolicy({
        nonce: "n",
        supabaseUrl: "http://localhost:54321",
        development: true,
      }),
    );
    expect(d["script-src"]).toContain("'unsafe-eval'");
    expect(d["connect-src"]).toEqual(["'self'", "http://localhost:54321", "ws:"]);
  });

  it("makes a fresh 16-byte nonce each time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(a, "base64")).toHaveLength(16);
  });
});
