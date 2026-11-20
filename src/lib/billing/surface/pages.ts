import "server-only";

/**
 * Reading every row of a query in pages, for the billing views' loaders and
 * prepare steps (./periods.ts, ./period-review.ts) and the bill engine's
 * reads of a period's tenants, bills and prior readings (../generate.ts).
 * PostgREST answers at most
 * max_rows rows (supabase/config.toml sets 1000) and says nothing when it
 * stops, so each page asks for the exact count of what is left. A read that
 * cannot be completed is a refusal, never a partial sum.
 */

export const BILL_PAGE = 1000;

type PageRead = { data: unknown; error: unknown; count?: number | null };

/**
 * Every row, in pages by id (keyset): each page starts after the last id of
 * the one before, so a row written between pages is neither skipped nor read
 * twice. Use it with pageAfter for any read that is summed, such as bills.
 */
export async function readAllPages<T extends { id: string }>(read: (afterId: string | null) => PromiseLike<PageRead>): Promise<T[] | null> {
  const out: T[] = [];
  for (let after: string | null = null; ; ) {
    const { data, error, count } = await read(after);
    if (error) return null;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    // Done when this page held everything left, or nothing.
    if (rows.length === 0 || (typeof count === "number" ? rows.length >= count : rows.length < BILL_PAGE)) return out;
    after = rows[rows.length - 1].id;
  }
}

/** A page of a query ordered by id: the first, or the one after `afterId`. */
export function pageAfter<Q extends { gt(column: string, value: string): Q; order(column: string): Q; limit(n: number): Q }>(
  query: Q,
  afterId: string | null,
): Q {
  return (afterId === null ? query : query.gt("id", afterId)).order("id").limit(BILL_PAGE);
}

/**
 * Every row, in pages by offset, for a read that must keep another order
 * (such as tenants by name) and is only listed, never summed: a row written
 * between pages can be skipped or repeated.
 */
export async function readAllPagesInOrder<T>(read: (from: number, to: number) => PromiseLike<PageRead>): Promise<T[] | null> {
  const out: T[] = [];
  for (let from = 0; ; from += BILL_PAGE) {
    const { data, error, count } = await read(from, from + BILL_PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length === 0) return out;
    if (typeof count === "number" ? out.length >= count : rows.length < BILL_PAGE) return out;
  }
}
