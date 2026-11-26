/**
 * The check a route makes on a typed confirmation: whether what the person
 * typed is the name they were asked to type, ignoring case and spacing.
 * Billing's period deletion and close, and community management's deletes,
 * check with this, so every typed name is compared the same way.
 *
 * Client-safe: it imports nothing.
 */
const normalise = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Whether `typed` is `name`, ignoring case and spacing; false when nothing was typed. */
export function typedNameMatches(typed: string | undefined, name: string): boolean {
  return typed !== undefined && normalise(typed) === normalise(name);
}
