/**
 * The sign-in code's string (#271): what the code page shows and the CLI
 * decodes. A round trip, the shapes refused, and what a terminal paste adds.
 */
import { describe, expect, it } from "vitest";
import { decodePastedCode, encodePastedCode } from "../pasted-code";

const STATE = "q2Yb3uXk0Jp7_rW-9aLmZtVnE4sHdFcG1oPiKyUw8xQ";
const CODE = "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b";

describe("the pasted sign-in code", () => {
  it("carries the state and the code in one string, and gives both back", () => {
    const text = encodePastedCode({ state: STATE, code: CODE });
    expect(text).toBe(`${STATE}.${CODE}`);
    expect(decodePastedCode(text!)).toEqual({ state: STATE, code: CODE });
  });

  it("ignores the spaces and line breaks a terminal paste adds", () => {
    expect(decodePastedCode(`  ${STATE}.${CODE}\r\n`)).toEqual({ state: STATE, code: CODE });
  });

  it.each([
    ["a state that is too short", { state: "short", code: CODE }],
    ["a state with characters outside base64url", { state: `${STATE}+/`, code: CODE }],
    ["a state with a dot", { state: `${STATE}.x`, code: CODE }],
    ["a state that is too long", { state: "a".repeat(513), code: CODE }],
    ["a code that is not a UUID", { state: STATE, code: "not-a-code" }],
    ["an empty code", { state: STATE, code: "" }],
    ["an empty state", { state: "", code: CODE }],
  ])("refuses to make one from %s", (_name, parts) => {
    expect(encodePastedCode(parts)).toBeNull();
  });

  it.each([
    ["no dot", `${STATE}${CODE}`],
    ["two dots", `${STATE}.${CODE}.x`],
    ["the parts the other way round", `${CODE}.${STATE}`],
    ["a space inside", `${STATE}. ${CODE}`],
    ["nothing", ""],
  ])("refuses a pasted string with %s", (_name, text) => {
    expect(decodePastedCode(text)).toBeNull();
  });
});
