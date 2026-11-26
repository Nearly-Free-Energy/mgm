/**
 * Each token file's own lock (RFC #259 decision 15; ADR-008, Consequences).
 *
 * Supabase Auth rotates refresh tokens, and a refresh token reused outside
 * the project's reuse window (10 seconds locally, `refresh_token_reuse_interval`)
 * revokes the session's tokens and signs the person out. So a command takes
 * the file's lock before it refreshes, and reads the file again under it
 * (session.ts): two commands never refresh with the same token.
 *
 * The lock is `<token file>.lock`, made with an exclusive create, holding
 * the holder's process id, host name, when it was taken and a random tag.
 * The lock is removed by its holder only while it still carries the
 * holder's tag.
 *
 * A lock is stale once it is older than STALE_MS, or, when it was taken on
 * this computer, once its process is gone. A lock taken on another computer
 * (a config folder on a network disk) counts as held until STALE_MS, since
 * its process cannot be seen from here. A holder that is still running
 * finishes well inside STALE_MS, since every request it makes gives up after
 * REQUEST_TIMEOUT_MS (http.ts).
 *
 * Taking over a stale lock (takeOver) is done by one waiter at a time: the
 * waiter first takes `<token file>.lock.break` with an exclusive create,
 * then checks again that the lock is the stale one it saw, renames it aside,
 * and deletes it only if what it renamed is that same file (same inode and
 * tag); otherwise it puts it back. So two waiters never both remove a stale
 * lock and then both take a new one. The break lock is held only for those
 * few file operations; one left behind by a command that was killed in
 * between is removed after BREAK_STALE_MS, and that removal alone is
 * check-then-delete.
 */
import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { CliError } from "./errors.ts";

export const STALE_MS = 60_000;
/** How long a command waits for another to finish before giving up. */
export const WAIT_MS = 30_000;
/** After this long a break lock is taken to be left behind by a command that stopped. */
export const BREAK_STALE_MS = 5_000;

type Holder = { pid: number; host: string | null; created: number; tag: string };

export type LockOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a process on this computer is still running. */
  alive?: (pid: number) => boolean;
  waitMs?: number;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseHolder(text: string): Holder | null {
  try {
    const holder = JSON.parse(text) as Partial<Holder>;
    if (typeof holder.pid !== "number" || typeof holder.created !== "number" || typeof holder.tag !== "string") return null;
    return { pid: holder.pid, host: typeof holder.host === "string" ? holder.host : null, created: holder.created, tag: holder.tag };
  } catch {
    return null;
  }
}

type Seen = { holder: Holder | null; ino: number; mtimeMs: number };

/** The lock at `lockPath` as it is now: who holds it (null while half-written) and which file it is. */
async function inspect(lockPath: string): Promise<Seen | null> {
  try {
    const st = await lstat(lockPath);
    const holder = parseHolder(await readFile(lockPath, "utf8"));
    return { holder, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Makes `lockPath` with an exclusive create, holding this command's holder record; false when it exists. */
async function create(lockPath: string, tag: string, now: () => number): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), created: now(), tag }), "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Removes the file at `path` only if it is still `seen` (same inode and the
 * same tag, or both half-written); puts back anything else it moved aside.
 */
async function removeIfStill(path: string, seen: Seen): Promise<void> {
  const aside = `${path}.stale.${randomBytes(8).toString("hex")}`;
  try {
    await rename(path, aside);
  } catch {
    return; // Gone already.
  }
  const moved = await inspect(aside);
  if (moved && moved.ino === seen.ino && (moved.holder?.tag ?? null) === (seen.holder?.tag ?? null)) {
    await unlink(aside).catch(() => {});
    return;
  }
  // Not the file judged stale: put it back for its holder.
  await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}

/**
 * Removes the stale lock at `lockPath`, one waiter at a time (see the top of
 * this file). Returns false when another waiter holds the break lock, so the
 * caller waits before it tries again.
 */
async function takeOver(lockPath: string, stale: (seen: Seen) => boolean, now: () => number, alive: (pid: number) => boolean): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  const tag = randomBytes(12).toString("hex");
  if (!(await create(breakPath, tag, now))) {
    const breaker = await inspect(breakPath);
    if (breaker) {
      const gone =
        breaker.holder === null
          ? Date.now() - breaker.mtimeMs > BREAK_STALE_MS
          : now() - breaker.holder.created > BREAK_STALE_MS || (breaker.holder.host === hostname() && !alive(breaker.holder.pid));
      if (gone) await removeIfStill(breakPath, breaker);
    }
    return false;
  }
  try {
    const seen = await inspect(lockPath);
    if (seen && stale(seen)) await removeIfStill(lockPath, seen);
  } finally {
    const mine = await inspect(breakPath);
    if (mine?.holder?.tag === tag) await unlink(breakPath).catch(() => {});
  }
  return true;
}

/** Runs `fn` while holding the lock of the token file at `path`. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.alive ?? processAlive;
  const lockPath = `${path}.lock`;
  const tag = randomBytes(12).toString("hex");
  const started = now();
  const here = hostname();
  let pause = 25;

  const stale = ({ holder, mtimeMs }: Seen): boolean =>
    // Half-written: being written right now, or left so by a command that
    // stopped; stale once older than a holder can be.
    holder === null
      ? Date.now() - mtimeMs > STALE_MS
      : now() - holder.created > STALE_MS || (holder.host === here && !alive(holder.pid));

  for (;;) {
    if (await create(lockPath, tag, now)) break;
    const seen = await inspect(lockPath);
    if (seen && stale(seen) && (await takeOver(lockPath, stale, now, alive))) continue;
    if (now() - started > (options.waitMs ?? WAIT_MS)) {
      throw new CliError("busy", "Another mgm command is using this sign-in. Wait for it to finish, then try again.");
    }
    await sleep(pause);
    pause = Math.min(pause * 2, 500);
  }

  try {
    return await fn();
  } finally {
    const holder = await inspect(lockPath);
    if (holder?.holder?.tag === tag) await unlink(lockPath).catch(() => {});
  }
}
