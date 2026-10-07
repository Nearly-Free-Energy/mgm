import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOpenEmsEdges } from "../edge-discovery";

class FakeWebSocket extends EventTarget {
  static latest: FakeWebSocket;
  url: string;
  sent: Array<Record<string, unknown>> = [];
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.latest = this;
  }
  send(payload: string) { this.sent.push(JSON.parse(payload)); }
  close() { /* no-op */ }
  reply(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

describe("OpenEMS UI edge listing", () => {
  const original = globalThis.WebSocket;
  beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); });
  afterEach(() => { vi.stubGlobal("WebSocket", original); });

  it("authenticates on the REST origin and pages through online and offline edges", async () => {
    const promise = listOpenEmsEdges({
      type: "direct_url", url: "https://example.org/rest",
      username: "reader", password: "password",
    });
    const socket = FakeWebSocket.latest;
    expect(socket.url).toBe("wss://example.org/openems-backend");
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent[0]).toMatchObject({
      method: "authenticateWithPassword",
      params: { username: "reader", password: "password" },
    });
    socket.reply({ jsonrpc: "2.0", id: socket.sent[0].id, result: {} });
    expect(socket.sent[1]).toMatchObject({ method: "getEdges", params: { page: 0, limit: 100 } });
    socket.reply({ jsonrpc: "2.0", id: socket.sent[1].id, result: {
      edges: [{ id: "online", comment: "Pilot", isOnline: true },
        { id: "offline", comment: "", isOnline: false }],
    } });
    await expect(promise).resolves.toEqual([
      { id: "online", name: "Pilot", online: true },
      { id: "offline", name: "offline", online: false },
    ]);
  });

  it("fails closed on authentication error without returning credentials", async () => {
    const promise = listOpenEmsEdges({
      type: "direct_url", url: "https://example.org/rest",
      username: "reader", password: "private-password",
    });
    const socket = FakeWebSocket.latest;
    socket.dispatchEvent(new Event("open"));
    socket.reply({ id: socket.sent[0].id, error: { code: 1003, message: "Authentication failed" } });
    await expect(promise).rejects.toMatchObject({ code: "OPENEMS_AUTH_FAILED" });
  });
});
