/**
 * The token store's owner-only rules (RFC #259 decision 15): files 0600 and
 * directories 0700, a file others could read refused on write and on every
 * read, a symbolic link never followed, and one file and one lock per
 * client kind.
 */
import { chmod, lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../lock.ts";
import { type Store, type TokenFile, assertSupportedPlatform, configBase, installationKey, tokenFilePath } from "../store.ts";
import { temporaryStore } from "./fake-installation.ts";

/** Makes the file system report group and other bits on every file mgm creates, as some do. */
const fs = vi.hoisted(() => ({ widen: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!fs.widen) return handle;
      const stat = handle.stat.bind(handle);
      return Object.assign(handle, {
        stat: async () => Object.assign(await stat(), { mode: 0o100644 }),
      });
    },
  };
});

const ORIGIN = "https://mgm.example.org";

function tokenFile(kind: "operator" | "agent" = "operator"): TokenFile {
  return {
    v: 1,
    installation: ORIGIN,
    supabase_url: "https://abc.supabase.co",
    anon_key: "anon",
    token_url: "https://abc.supabase.co/auth/v1/oauth/token",
    client_id: "0b6c1c9e-5d0a-4c8e-9f63-3c1f0a7d2e41",
    kind,
    access_token: "a.b.c",
    refresh_token: "r",
    expires_at: Date.now() + 3_600_000,
    user: { id: "u", email: "person@example.org" },
    saved_at: new Date().toISOString(),
  };
}

let store: Store;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  fs.widen = false;
  ({ store, cleanup } = await temporaryStore());
});
afterEach(async () => {
  await cleanup();
});

describe("where the files are", () => {
  it("keeps each installation's files apart, one per client kind", () => {
    const base = "/home/p/.config/mgm";
    expect(tokenFilePath(base, ORIGIN, "operator")).toBe("/home/p/.config/mgm/installations/https+mgm.example.org/operator.json");
    expect(tokenFilePath(base, ORIGIN, "agent")).toBe("/home/p/.config/mgm/installations/https+mgm.example.org/agent.json");
    expect(installationKey("http://127.0.0.1:3000")).toBe("http+127.0.0.1+3000");
    expect(installationKey("http://[::1]:3000")).toBe("http+_3a_3a1+3000");
  });

  it("gives every origin its own folder", () => {
    const origins = [
      "https://mgm.example.org",
      "http://mgm.example.org",
      "https://mgm.example.org:8443",
      "https://mgm.example.org-8443",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://[::1]:3000",
      "http://_3a_3a1:3000",
      "https://a_b.example.org",
      "https://a_5fb.example.org",
    ];
    expect(new Set(origins.map(installationKey)).size).toBe(origins.length);
    // The same origin, however it is written, is one folder.
    expect(installationKey("https://MGM.example.org:443")).toBe(installationKey("https://mgm.example.org"));
  });

  it("uses XDG_CONFIG_HOME, else the platform's place", () => {
    expect(configBase({ XDG_CONFIG_HOME: "/x/config" }, "linux", "/home/p")).toBe("/x/config/mgm");
    expect(configBase({}, "linux", "/home/p")).toBe("/home/p/.config/mgm");
    expect(configBase({}, "darwin", "/Users/p")).toBe("/Users/p/Library/Application Support/mgm");
  });

  it("refuses Windows, where the owner-only check cannot be made yet", () => {
    expect(() => assertSupportedPlatform("win32")).toThrow(/macOS and Linux/);
    expect(() => assertSupportedPlatform("linux")).not.toThrow();
  });
});

describe.skipIf(process.platform === "win32")("owner-only files", () => {
  it("writes the file 0600 in directories that are 0700", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    const written = tokenFile();
    await store.writeToken(path, written);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    for (const dir of [store.base, join(store.base, "installations"), join(store.base, "installations", installationKey(ORIGIN))]) {
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    }
    expect(await store.readToken(path)).toEqual(written);
    // Only the file: the temporary one it was written to is gone.
    expect(await readdir(join(store.base, "installations", installationKey(ORIGIN)))).toEqual(["operator.json"]);
  });

  it("refuses to write a file the file system leaves readable by others, and leaves nothing behind", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    fs.widen = true;
    await expect(store.writeToken(path, tokenFile())).rejects.toThrow(/could not make .* readable only by you .*mode 644/);
    fs.widen = false;
    expect(await readdir(join(store.base, "installations", installationKey(ORIGIN)))).toEqual([]);
  });

  it.each([0o640, 0o604, 0o660, 0o666])("refuses to read a file with mode %o, and says how to fix it", async (mode) => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(path, tokenFile());
    await chmod(path, mode);
    await expect(store.readToken(path)).rejects.toThrow(new RegExp(`Others can read .*chmod 600`));
  });

  it("checks the file again on every read", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(path, tokenFile());
    await expect(store.readToken(path)).resolves.not.toBeNull();
    await chmod(path, 0o644);
    await expect(store.readToken(path)).rejects.toThrow(/Others can read/);
    await chmod(path, 0o600);
    await expect(store.readToken(path)).resolves.not.toBeNull();
  });

  it("refuses a symbolic link in the file's place", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    const elsewhere = join(store.base, "elsewhere.json");
    await store.writeToken(elsewhere, tokenFile());
    await mkdir(join(store.base, "installations", installationKey(ORIGIN)), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, path);
    await expect(store.readToken(path)).rejects.toThrow(/symbolic link/);
  });

  it("refuses a directory others can write to", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(path, tokenFile());
    await chmod(join(store.base, "installations"), 0o777);
    await expect(store.writeToken(path, tokenFile())).rejects.toThrow(/Others can write to .*chmod 700/);
  });

  it("reads no file as not signed in, and refuses one it cannot read", async () => {
    const path = tokenFilePath(store.base, ORIGIN, "operator");
    expect(await store.readToken(path)).toBeNull();
    await mkdir(join(store.base, "installations", installationKey(ORIGIN)), { recursive: true, mode: 0o700 });
    await writeFile(path, "{}", { mode: 0o600 });
    await expect(store.readToken(path)).rejects.toThrow(/not a token file/);
  });
});

describe.skipIf(process.platform === "win32")("one file and one lock per client", () => {
  it("keeps the operator and agent files apart", async () => {
    const operator = tokenFilePath(store.base, ORIGIN, "operator");
    const agent = tokenFilePath(store.base, ORIGIN, "agent");
    await store.writeToken(operator, tokenFile("operator"));
    await store.writeToken(agent, tokenFile("agent"));
    expect((await store.readToken(operator))?.kind).toBe("operator");
    expect((await store.readToken(agent))?.kind).toBe("agent");
    await store.remove(operator);
    expect(await store.readToken(operator)).toBeNull();
    expect((await store.readToken(agent))?.kind).toBe("agent");
  });

  it("lets one client's lock be taken while the other's is held", async () => {
    const operator = tokenFilePath(store.base, ORIGIN, "operator");
    const agent = tokenFilePath(store.base, ORIGIN, "agent");
    await store.writeToken(operator, tokenFile("operator"));
    await store.writeToken(agent, tokenFile("agent"));
    let release!: () => void;
    const held = withFileLock(operator, () => new Promise<void>((resolve) => (release = resolve)));
    await vi.waitFor(() => lstat(`${operator}.lock`));
    const order: string[] = [];
    await withFileLock(agent, async () => order.push("agent"), { waitMs: 200 });
    await expect(withFileLock(operator, async () => order.push("operator"), { waitMs: 200 })).rejects.toThrow(/Another mgm command/);
    release();
    await held;
    await withFileLock(operator, async () => order.push("operator"));
    expect(order).toEqual(["agent", "operator"]);
  });

  it("takes over a lock whose command has stopped", async () => {
    const operator = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(operator, tokenFile());
    await writeFile(`${operator}.lock`, JSON.stringify({ pid: 999_999, host: hostname(), created: Date.now(), tag: "gone" }));
    const ran = await withFileLock(operator, async () => "ran", { alive: () => false, waitMs: 200 });
    expect(ran).toBe("ran");
    expect((await readdir(dirname(operator))).sort()).toEqual(["operator.json"]);
  });

  it("counts a lock taken on another computer as held until it is old, whatever its process id", async () => {
    const operator = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(operator, tokenFile());
    await writeFile(`${operator}.lock`, JSON.stringify({ pid: 999_999, host: "another-computer", created: Date.now(), tag: "there" }));
    await expect(withFileLock(operator, async () => "ran", { alive: () => false, waitMs: 200 })).rejects.toThrow(/Another mgm command/);
    const later = () => Date.now() + 61_000;
    expect(await withFileLock(operator, async () => "ran", { alive: () => false, now: later })).toBe("ran");
  });

  it("lets only one of several waiters take over one stale lock at a time", async () => {
    const operator = tokenFilePath(store.base, ORIGIN, "operator");
    await store.writeToken(operator, tokenFile());
    const STOPPED = 999_999;
    const alive = (pid: number) => pid !== STOPPED;
    for (let round = 0; round < 20; round += 1) {
      await writeFile(`${operator}.lock`, JSON.stringify({ pid: STOPPED, host: hostname(), created: Date.now(), tag: `gone-${round}` }));
      let inside = 0;
      let most = 0;
      const holder = async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inside -= 1;
      };
      await Promise.all(Array.from({ length: 6 }, () => withFileLock(operator, holder, { alive, sleep: () => new Promise((r) => setImmediate(r)) })));
      expect(most).toBe(1);
    }
    expect((await readdir(dirname(operator))).sort()).toEqual(["operator.json"]);
  });
});
