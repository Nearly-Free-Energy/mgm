/**
 * The limits on clients that are not a browser (client-limits.ts): each
 * allows up to its limit per person and client in a minute, then refuses
 * with the seconds to wait, counts each person and each client apart, keeps
 * its own count, and lets requests through again once the minute has
 * passed. Middleware's and the host's use of them are tested in
 * middleware.test.ts and vendor-limit.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_REQUESTS_PER_WINDOW,
  CLIENT_REQUEST_WINDOW_MS,
  CLIENT_VENDOR_READS_PER_WINDOW,
  CLIENT_VENDOR_WINDOW_MS,
  _resetClientLimitersForTests,
  checkClientRequest,
  checkClientVendorRead,
} from "../client-limits";

const PERSON = "e7100000-0000-4000-8fff-000000000001";
const OTHER_PERSON = "e7100000-0000-4000-8fff-000000000002";
const CLI = "e7100000-0000-4000-8fff-0000000000c1";
const OTHER_CLIENT = "e7100000-0000-4000-8fff-0000000000c2";
const T0 = Date.parse("2026-11-26T08:00:00Z");

beforeEach(() => _resetClientLimitersForTests());

describe.each([
  ["requests", checkClientRequest, CLIENT_REQUESTS_PER_WINDOW, CLIENT_REQUEST_WINDOW_MS],
  ["vendor view loads", checkClientVendorRead, CLIENT_VENDOR_READS_PER_WINDOW, CLIENT_VENDOR_WINDOW_MS],
] as const)("a client's %s", (_label, check, limit, windowMs) => {
  const fill = (userId: string, clientId: string) => {
    for (let i = 0; i < limit; i++) expect(check({ userId, clientId }, T0 + i).ok).toBe(true);
  };

  it("are allowed up to the limit, then refused with the seconds to wait", () => {
    fill(PERSON, CLI);
    const refused = check({ userId: PERSON, clientId: CLI }, T0 + 1_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBe(Math.ceil((windowMs - 1_000) / 1000));
  });

  it("are counted apart for each person and each client", () => {
    fill(PERSON, CLI);
    expect(check({ userId: PERSON, clientId: CLI }, T0 + limit).ok).toBe(false);
    expect(check({ userId: PERSON, clientId: OTHER_CLIENT }, T0 + limit).ok).toBe(true);
    expect(check({ userId: OTHER_PERSON, clientId: CLI }, T0 + limit).ok).toBe(true);
  });

  it("are allowed again once the window has passed", () => {
    fill(PERSON, CLI);
    expect(check({ userId: PERSON, clientId: CLI }, T0 + windowMs + limit).ok).toBe(true);
  });

  it("start again from nothing after the reset for tests", () => {
    fill(PERSON, CLI);
    _resetClientLimitersForTests();
    expect(check({ userId: PERSON, clientId: CLI }, T0 + limit).ok).toBe(true);
  });
});

describe("the two limits", () => {
  it("keep their own counts", () => {
    for (let i = 0; i < CLIENT_VENDOR_READS_PER_WINDOW; i++) checkClientVendorRead({ userId: PERSON, clientId: CLI }, T0);
    expect(checkClientVendorRead({ userId: PERSON, clientId: CLI }, T0).ok).toBe(false);
    expect(checkClientRequest({ userId: PERSON, clientId: CLI }, T0).ok).toBe(true);
  });

  it("are lower for a vendor view than for requests", () => {
    expect(CLIENT_VENDOR_READS_PER_WINDOW).toBeLessThan(CLIENT_REQUESTS_PER_WINDOW);
  });
});
