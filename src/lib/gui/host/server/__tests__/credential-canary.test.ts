/** The canary scan (./credential-canary.ts) on its own: each form it looks for is caught by itself. */
import { describe, expect, it } from "vitest";
import { assertNoCanary, type Canary } from "./credential-canary";

// The "???>>>" in the random part makes the base64 carry both "+" and "/".
const plaintext = "CANARY-unit_encrypted-???>>>0123456789abcdeffedcba9876543210";
const ciphertext = "\\xc30d04070302a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";
const c: Canary = { column: "t.unit_encrypted", table: "t", field: "unit_encrypted", rowId: "r", plaintext, ciphertext };
const plain = Buffer.from(plaintext);
const cipher = Buffer.from(ciphertext.slice(2), "hex");
const check = (text: string) => () => assertNoCanary(`before ${text} after`, [c], "unit");

describe("assertNoCanary", () => {
  it("has a plaintext whose base64 needs both alphabets", () => {
    expect(plain.toString("base64")).toMatch(/\+.*\/|\/.*\+/);
  });

  it.each([
    ["plaintext", plaintext],
    ["plaintext in upper case", plaintext.toUpperCase()],
    ["a copy cut off after half the random part", plaintext.slice(0, -16)],
    ["hex", plain.toString("hex")],
    ["hex in upper case", plain.toString("hex").toUpperCase()],
    ["padded base64", plain.toString("base64")],
    ["base64url", plain.toString("base64url")],
    ["base64 one byte in", Buffer.concat([Buffer.from("u"), plain]).toString("base64")],
    ["base64 two bytes in", Buffer.concat([Buffer.from("us"), plain]).toString("base64")],
    ["base64url two bytes in", Buffer.concat([Buffer.from("us"), plain]).toString("base64url")],
    ["a Basic header", `Basic ${Buffer.from(`canary:${plaintext}`).toString("base64")}`],
    ["ciphertext hex", ciphertext.slice(2)],
    ["ciphertext as stored", ciphertext],
    ["ciphertext base64", cipher.toString("base64")],
    ["ciphertext base64url", cipher.toString("base64url")],
    ["ciphertext base64 one byte in", Buffer.concat([Buffer.from("u"), cipher]).toString("base64")],
  ])("catches %s", (_name, text) => {
    expect(check(text)).toThrow("t.unit_encrypted");
  });

  it("passes output with no canary", () => {
    expect(check("CANARY-unit_encrypted- Battery 0123456 Basic Y2FuYXJ5Og==")).not.toThrow();
  });
});
