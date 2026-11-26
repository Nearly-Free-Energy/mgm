/**
 * Opens the sign-in address in the person's browser, where there is one. The
 * address is always printed as well, so a sign-in works over SSH and on a
 * server: the person opens it on any device and pastes the code back. No
 * local port is opened (ADR-008 decision 3).
 */
import { spawn } from "node:child_process";
import type { Env } from "./store.ts";

/** The command that opens `url`, or null where there is no browser to open. */
export function openerFor(url: string, platform: string, env: Env): { command: string; args: string[] } | null {
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    return { command: "xdg-open", args: [url] };
  }
  return null;
}

/** Tries to open `url`; true when an opener was started. */
export async function openBrowser(url: string, platform: string, env: Env): Promise<boolean> {
  const opener = openerFor(url, platform, env);
  if (!opener) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
