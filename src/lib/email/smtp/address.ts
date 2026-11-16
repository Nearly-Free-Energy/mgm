/**
 * Where an organization's mail server may be: a public DNS name, resolved
 * once at send time to public addresses only. The transport then connects to
 * the address checked here, so the name cannot resolve somewhere else between
 * the check and the connection (RFC #186 § 3).
 *
 * The server's name is typed by an org manager and this server connects to
 * it, so a private, loopback, link-local or otherwise non-public address is
 * refused. The list is stricter than the OpenEMS URL check
 * (src/lib/openems/backend-url.ts) because it runs on resolved addresses
 * rather than on what was typed.
 */
import "server-only";

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The host as it is stored: trimmed, lowercased, without a trailing dot.
 * Null when it is not a DNS name with at least one dot, or is an address
 * literal (TLS checks the certificate against the name, so a name is
 * required). The database repeats the shape check
 * (organization_email_senders_host_shape).
 */
export function normalizeMailHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || isIP(host)) return null;
  if (!HOST_RE.test(host)) return null;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  return host;
}

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64, which embeds an IPv4 address
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** True when `address` (an IP literal) is not a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_PUBLIC.check(mapped[1], "ipv4");
  return NON_PUBLIC.check(address, "ipv6");
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export type ResolvedHost =
  | { ok: true; address: string }
  | { ok: false; reason: "unreachable" | "refused_address"; message: string };

/**
 * One public address for `host`, or why there is none. When any address the
 * name resolves to is non-public, the name is refused outright rather than
 * filtered: a name that mixes them is not one this server should call.
 */
export async function resolvePublicAddress(host: string, lookup: Lookup = defaultLookup): Promise<ResolvedHost> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: "unreachable", message: `Could not find the mail server ${host}. Check its name.` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "unreachable", message: `Could not find the mail server ${host}. Check its name.` };
  }
  if (addresses.some(({ address }) => isNonPublicAddress(address))) {
    return {
      ok: false,
      reason: "refused_address",
      message: `${host} points at a private or reserved address, which MGM will not connect to. Use the mail server's public name.`,
    };
  }
  return { ok: true, address: addresses[0].address };
}
