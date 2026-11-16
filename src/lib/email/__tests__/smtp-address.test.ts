import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isNonPublicAddress, normalizeMailHost, resolvePublicAddress } from "../smtp/address";

describe("normalizeMailHost", () => {
  it.each([
    ["smtp.example.com", "smtp.example.com"],
    ["  SMTP.Example.COM. ", "smtp.example.com"],
    ["mail-1.eu.example.org", "mail-1.eu.example.org"],
  ])("accepts %j as %j", (raw, host) => {
    expect(normalizeMailHost(raw)).toBe(host);
  });

  it.each([
    "",
    "localhost",
    "mail.localhost",
    "printer.local",
    "smtp.corp.internal",
    "203.0.113.5",
    "[::1]",
    "::1",
    "smtp.example.com:587",
    "smtp://smtp.example.com",
    "user@smtp.example.com",
    "-smtp.example.com",
    "smtp_example.com",
  ])("refuses %j", (raw) => {
    expect(normalizeMailHost(raw)).toBeNull();
  });
});

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-address",
  ])("treats %s as non-public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "142.250.1.27", "2607:f8b0:4004:c1b::1a", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (address) => {
      expect(isNonPublicAddress(address)).toBe(false);
    }
  );
});

describe("resolvePublicAddress", () => {
  it("returns the first address when every address is public", async () => {
    const lookup = vi.fn(async () => [
      { address: "142.250.1.27", family: 4 },
      { address: "142.250.1.26", family: 4 },
    ]);
    await expect(resolvePublicAddress("smtp.example.com", lookup)).resolves.toEqual({ ok: true, address: "142.250.1.27" });
    expect(lookup).toHaveBeenCalledWith("smtp.example.com");
  });

  it("refuses a name when any address it resolves to is non-public", async () => {
    const lookup = async () => [
      { address: "142.250.1.27", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(resolvePublicAddress("smtp.example.com", lookup)).resolves.toMatchObject({
      ok: false,
      reason: "refused_address",
    });
  });

  it("reports a name that does not resolve as unreachable", async () => {
    const lookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(resolvePublicAddress("smtp.example.com", lookup)).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });
});
