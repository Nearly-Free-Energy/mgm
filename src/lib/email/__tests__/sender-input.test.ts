import { describe, expect, it } from "vitest";
import { parseSenderInput } from "../sender-input";

const VALID = {
  host: " smtp.example.com ",
  port: 587,
  username: "notices@example.com",
  password: " pass with spaces ",
  fromAddress: "notices@example.com",
  fromName: "Kiwumu Energy",
  replyTo: "",
  version: null,
};

describe("parseSenderInput", () => {
  it("trims text fields, keeps the password as typed, and empties blank optional fields", () => {
    expect(parseSenderInput(VALID)).toEqual({
      ok: true,
      value: {
        host: "smtp.example.com",
        port: 587,
        username: "notices@example.com",
        password: " pass with spaces ",
        fromAddress: "notices@example.com",
        fromName: "Kiwumu Energy",
        replyTo: null,
        version: null,
      },
    });
  });

  it.each([
    [{ ...VALID, host: "" }, "host"],
    [{ ...VALID, port: 25 }, "port"],
    [{ ...VALID, port: "587" }, "port"],
    [{ ...VALID, username: "" }, "username"],
    [{ ...VALID, username: "a\r\nBcc: x@example.com" }, "username"],
    [{ ...VALID, fromAddress: "not-an-address" }, "fromAddress"],
    [{ ...VALID, fromName: "Kiwumu\nBcc: x@example.com" }, "fromName"],
    [{ ...VALID, replyTo: "nope" }, "replyTo"],
    [{ ...VALID, version: 0 }, "version"],
    [{ ...VALID, version: "1" }, "version"],
    [null, "body"],
    [[VALID], "body"],
  ])("refuses %j on %s", (body, field) => {
    expect(parseSenderInput(body)).toMatchObject({ ok: false, field });
  });
});
