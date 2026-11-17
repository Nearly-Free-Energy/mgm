import "server-only";
/**
 * The deployment's own mail sender (RFC #186): the only sender that carries
 * sign-in links and codes (decision 5), and the one notices fall back to
 * when an organization has none (decisions 1 and 2).
 *
 *   MGM_SMTP_URL   smtps://user:password@smtp.example.com:465
 *                  smtp://user:password@smtp.example.com:587   (STARTTLS required)
 *                  smtp://127.0.0.1:54325   local mail catcher, plaintext;
 *                                           allowed only on a loopback host
 *                  smtp://mailpit:1025      the same, by a container-network
 *                                           name with no dot (docker compose),
 *                                           only with the opt-in below
 *   MGM_MAIL_FROM  MGM <no-reply@example.com>, or a bare address
 *   MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1
 *                  allows plaintext to a container-network name. Without it
 *                  such a name is refused: sign-in links are credentials,
 *                  and in production a dotless name may be a cluster service
 *                  or a search-domain expansion on another machine.
 *
 * Read per call, like MGM_APP_URL (app-url.ts), and errors name the variable
 * without echoing it: the URL holds the mail password. The URL's user and
 * password are percent-decoded, so a password with "@" or "/" is written
 * percent-encoded.
 */
import type { SmtpSenderSettings } from "@/lib/email/types";
import { CONTAINER_HOST_RE, normalizeMailHost } from "@/lib/email/smtp/address";
import { RuntimeConfigError, type RuntimeEnv } from "./public-runtime-config";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseFrom(value: string): { fromAddress: string; fromName: string | null } {
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const fromName = named ? named[1].replace(/^"|"$/g, "").trim() || null : null;
  const fromAddress = (named ? named[2] : value).trim();
  if (!EMAIL_RE.test(fromAddress) || /[\r\n]/.test(value)) {
    throw new RuntimeConfigError("MGM_MAIL_FROM must be an email address, optionally as Name <address>.");
  }
  return { fromAddress, fromName };
}

/** Pure parser: the deployment sender's settings. */
export function parseDeploymentSender(env: RuntimeEnv): SmtpSenderSettings {
  const raw = present(env.MGM_SMTP_URL);
  const from = present(env.MGM_MAIL_FROM);
  if (!raw || !from) {
    throw new RuntimeConfigError(
      "Missing required runtime configuration: MGM_SMTP_URL and MGM_MAIL_FROM. " +
        'See docs/setup.md, section "Runtime configuration".'
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RuntimeConfigError("MGM_SMTP_URL is not a valid URL.");
  }
  if (url.pathname.replace(/^\/+/, "") || url.search || url.hash) {
    throw new RuntimeConfigError("MGM_SMTP_URL must not have a path, query or fragment.");
  }

  // smtp: is not a special scheme, so URL keeps the host's case.
  const hostname = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(hostname);
  const container = !loopback && CONTAINER_HOST_RE.test(hostname);
  const local = loopback || container;
  let port: number;
  if (url.protocol === "smtps:") {
    port = Number(url.port || 465);
  } else if (url.protocol === "smtp:") {
    port = Number(url.port || 587);
  } else {
    throw new RuntimeConfigError("MGM_SMTP_URL must use smtps:// or smtp://.");
  }

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const { fromAddress, fromName } = parseFrom(from);

  if (local && url.protocol === "smtp:") {
    if (container && env.MGM_SMTP_ALLOW_PLAINTEXT_LOCAL !== "1") {
      throw new RuntimeConfigError(
        "MGM_SMTP_URL names a plaintext mail server by a name with no dot; set MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1 only where that is a local mail catcher in this container network (docker compose)."
      );
    }
    // The local mail catcher: plaintext, on this machine or in its
    // container network only.
    return {
      kind: "smtp",
      host: hostname === "[::1]" ? "::1" : hostname,
      port,
      username,
      password,
      fromAddress,
      fromName,
      replyTo: null,
      plaintextLocal: true,
    };
  }

  const host = normalizeMailHost(hostname);
  if (!host) {
    throw new RuntimeConfigError(
      "MGM_SMTP_URL must name its mail server by a public DNS name (plaintext smtp:// is allowed only for localhost, or with MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1 for a container-network name with no dot)."
    );
  }
  if (url.protocol === "smtps:" && port !== 465) {
    throw new RuntimeConfigError("MGM_SMTP_URL: smtps:// is TLS from the first byte, on port 465.");
  }
  if (!username || !password) {
    throw new RuntimeConfigError("MGM_SMTP_URL must include the mail server's username and password.");
  }
  return { kind: "smtp", host, port, username, password, fromAddress, fromName, replyTo: null };
}

function readEnv(): RuntimeEnv {
  return {
    MGM_SMTP_URL: process.env.MGM_SMTP_URL,
    MGM_MAIL_FROM: process.env.MGM_MAIL_FROM,
    MGM_SMTP_ALLOW_PLAINTEXT_LOCAL: process.env.MGM_SMTP_ALLOW_PLAINTEXT_LOCAL,
  };
}

/** The deployment sender for this request; throws RuntimeConfigError when unset or invalid. */
export function getDeploymentSender(env: RuntimeEnv = readEnv()): SmtpSenderSettings {
  return parseDeploymentSender(env);
}
