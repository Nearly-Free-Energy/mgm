import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares a server-held secret with a value taken from a request in
 * constant time. Both strings are hashed with SHA-256 first, so the digests
 * always have the same length and `timingSafeEqual` runs on every call: the
 * time taken depends on neither where the strings first differ nor whether
 * their lengths match.
 *
 * An empty `expected` never matches, so a caller that forgets its own
 * "not configured" check still refuses everyone.
 */
export function secretMatches(expected: string, provided: string | null | undefined): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided ?? "", "utf8").digest();
  const equal = timingSafeEqual(expectedDigest, providedDigest);
  return equal && expected.length > 0;
}
