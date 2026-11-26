/**
 * The token store (RFC #259 decision 15; ADR-008, Consequences). README.md
 * describes it for people; this is the code.
 *
 * - One file per installation and client kind:
 *   `<base>/installations/<installationKey>/<kind>.json`. `mgm login` writes
 *   only the operator file; `mgm mcp` (D1) writes and reads the agent file
 *   and never the operator one. Each file names its client id inside.
 * - `<base>/config.json` names the installation a command uses when it is
 *   given no `--url`, and the addresses `mgm login` was given that redirect
 *   to an installation's own (`aliases`), so `--url <alias>` finds its file.
 * - Every directory mgm makes is 0700 and every file 0600. A file is
 *   written to a new temporary file, checked, and renamed over the old one,
 *   so a reader never sees half a file. The check refuses a file the file
 *   system left readable by others (some report every file as 0777), and
 *   deletes it.
 * - Every read opens the file without following a symbolic link and refuses
 *   one that is not a regular file of this user's that only this user can
 *   read, saying why.
 *
 * Windows is refused for now (assertSupportedPlatform): Node reports every
 * file there as readable by everyone, so the owner-only check cannot be made
 * from the mode, and how to check it from the file's access list is open
 * (#297).
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type { ClientKind } from "../../../src/lib/auth/discovery-answer.ts";
import { CliError } from "./errors.ts";
import { type LockOptions, withFileLock } from "./lock.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** Refuses a platform where the owner-only check cannot be made yet. */
export function assertSupportedPlatform(platform: string): void {
  if (platform === "win32") {
    throw new CliError(
      "unsupported_platform",
      "mgm keeps its sign-in only on macOS and Linux for now: on Windows it cannot yet check that only you can read the token file. Use MGM in a browser, or mgm from WSL.",
    );
  }
}

/**
 * Where mgm keeps its files: `$XDG_CONFIG_HOME/mgm` when that is set, else
 * `~/Library/Application Support/mgm` on macOS and `~/.config/mgm`
 * elsewhere.
 */
export function configBase(env: Env, platform: string, home: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && xdg.startsWith("/")) return join(xdg, "mgm");
  if (platform === "darwin") return join(home, "Library", "Application Support", "mgm");
  return join(home, ".config", "mgm");
}

/**
 * A file-name-safe key for an installation's origin, one per origin:
 * `<scheme>+<host>[+<port>]`. A host character other than a letter, digit,
 * `.` or `-` is written `_` and its two hex digits (`[::1]` becomes
 * `_3a_3a1`), so no two origins share a key and `+` only ever separates.
 */
export function installationKey(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  const parts = [url.protocol.replace(/:$/, ""), host];
  if (url.port) parts.push(url.port);
  return parts.join("+");
}

export function tokenFilePath(base: string, origin: string, kind: ClientKind): string {
  return join(base, "installations", installationKey(origin), `${kind}.json`);
}

export function configFilePath(base: string): string {
  return join(base, "config.json");
}

/** What a token file holds. */
export type TokenFile = {
  v: 1;
  /** The installation's origin (its MGM_APP_URL's). */
  installation: string;
  supabase_url: string;
  anon_key: string;
  token_url: string;
  client_id: string;
  kind: ClientKind;
  access_token: string;
  refresh_token: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expires_at: number;
  user: { id: string; email: string | null };
  saved_at: string;
};

type Config = { current: string | null; aliases: Record<string, string> };

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * The checks and writes, for one user. `uid` is the user's id, or
 * undefined where the platform has none (the owner check is then skipped).
 */
export class Store {
  readonly base: string;
  private readonly uid: number | undefined;

  constructor(base: string, uid: number | undefined) {
    this.base = base;
    this.uid = uid;
  }

  /**
   * Makes `dir` and every directory between it and the base, 0700, and
   * refuses one that is a symbolic link, belongs to someone else, or that
   * others may write to (they could then replace a token file).
   */
  async privateDirectory(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
    const steps = relative(this.base, dir).split(sep).filter(Boolean);
    let current = this.base;
    for (const step of [null, ...steps]) {
      if (step) current = join(current, step);
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new CliError("unsafe_directory", `${current} is not a plain directory. Move it away, then try again.`);
      }
      if (this.uid !== undefined && st.uid !== this.uid) {
        throw new CliError("unsafe_directory", `${current} belongs to another user. Move it away, then try again.`);
      }
      if ((st.mode & 0o022) !== 0) {
        throw new CliError("unsafe_directory", `Others can write to ${current}. Run: chmod 700 '${current}'`);
      }
    }
  }

  /** Writes `text` to `path`, readable and writable by this user only, replacing it whole. */
  async writePrivate(path: string, text: string): Promise<void> {
    await this.privateDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", FILE_MODE);
    let renamed = false;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
      const st = await handle.stat();
      if ((st.mode & 0o077) !== 0 || (this.uid !== undefined && st.uid !== this.uid)) {
        throw new CliError(
          "unsafe_file",
          `mgm could not make ${path} readable only by you (the file system gave it mode ${(st.mode & 0o777).toString(8)}), so it saved nothing. Keep mgm's files on a disk with Unix permissions, for example by setting XDG_CONFIG_HOME to a folder on one.`,
        );
      }
      await handle.close();
      await rename(temporary, path);
      renamed = true;
    } finally {
      if (!renamed) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    }
  }

  /**
   * The text of `path`, or null when there is none. Refuses a symbolic link,
   * a file of another user's, and a file others can read or write.
   */
  async readPrivate(path: string): Promise<string | null> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") {
        throw new CliError("unsafe_file", `${path} is a symbolic link, so mgm will not read it. Delete it and run mgm login again.`);
      }
      throw error;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new CliError("unsafe_file", `${path} is not a plain file. Delete it and run mgm login again.`);
      if (this.uid !== undefined && st.uid !== this.uid) {
        throw new CliError("unsafe_file", `${path} belongs to another user, so mgm will not use it. Delete it and run mgm login again.`);
      }
      if ((st.mode & 0o077) !== 0) {
        throw new CliError(
          "unsafe_file",
          `Others can read ${path} (mode ${(st.mode & 0o777).toString(8)}), so mgm will not use it. Run: chmod 600 '${path}'. If someone else may have read it, revoke the app from Connected apps in MGM and run mgm login again.`,
        );
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  /** Runs `fn` holding the lock of the token file at `path` (lock.ts), in its private directory. */
  async withLock<T>(path: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
    await this.privateDirectory(dirname(path));
    return withFileLock(path, fn, options);
  }

  /** Deletes `path`; nothing when it is already gone. */
  async remove(path: string): Promise<void> {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async readToken(path: string): Promise<TokenFile | null> {
    const text = await this.readPrivate(path);
    if (text === null) return null;
    let file: Partial<TokenFile> | null = null;
    try {
      file = JSON.parse(text) as Partial<TokenFile>;
    } catch {
      file = null;
    }
    if (
      file?.v !== 1 ||
      typeof file.installation !== "string" ||
      typeof file.access_token !== "string" ||
      typeof file.refresh_token !== "string" ||
      typeof file.client_id !== "string" ||
      typeof file.token_url !== "string" ||
      typeof file.anon_key !== "string" ||
      typeof file.expires_at !== "number" ||
      (file.kind !== "operator" && file.kind !== "agent")
    ) {
      throw new CliError("bad_token_file", `${path} is not a token file this mgm can read. Run mgm login again.`);
    }
    return file as TokenFile;
  }

  writeToken(path: string, file: TokenFile): Promise<void> {
    return this.writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  private async readConfig(): Promise<Config> {
    const text = await this.readPrivate(configFilePath(this.base));
    const config: Config = { current: null, aliases: {} };
    if (text === null) return config;
    try {
      const raw = JSON.parse(text) as { current?: unknown; aliases?: unknown };
      if (typeof raw.current === "string") config.current = raw.current;
      if (typeof raw.aliases === "object" && raw.aliases !== null && !Array.isArray(raw.aliases)) {
        for (const [alias, origin] of Object.entries(raw.aliases)) {
          if (typeof origin === "string") config.aliases[alias] = origin;
        }
      }
    } catch {
      // An unreadable config names nothing; the next login rewrites it.
    }
    return config;
  }

  /** The installation commands use when given no `--url`, or null. */
  async currentInstallation(): Promise<string | null> {
    return (await this.readConfig()).current;
  }

  /** The installation's own origin that `typed` redirected to at `mgm login`, or null. */
  async aliasOf(typed: string): Promise<string | null> {
    return (await this.readConfig()).aliases[typed] ?? null;
  }

  /**
   * Makes `origin` the installation commands use without `--url`, and, when
   * the person typed another address that led there, remembers it.
   */
  async setCurrentInstallation(origin: string, typed?: string): Promise<void> {
    const config = await this.readConfig().catch((): Config => ({ current: null, aliases: {} }));
    config.current = origin;
    if (typed !== undefined && typed !== origin) config.aliases[typed] = origin;
    else if (typed !== undefined) delete config.aliases[typed];
    await this.writePrivate(configFilePath(this.base), `${JSON.stringify({ v: 1, ...config }, null, 2)}\n`);
  }
}
