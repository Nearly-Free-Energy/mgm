import "server-only";

/**
 * Reading every row of a query in pages, for the billing views' loaders and
 * prepare steps (./periods.ts, ./period-review.ts).
 */

/**
 * Bills are read in pages. PostgREST answers at most max_rows rows
 * (supabase/config.toml sets 1000) and says nothing when it stops, so a read
 * that can return more pages by id until it has the exact count. A read
 * that cannot be completed is a refusal, never a partial sum.
 */
export const BILL_PAGE = 1000;

type PageRead = { data: unknown; error: unknown; count?: number | null };

export async function readAllPages<T>(read: (from: number, to: number) => PromiseLike<PageRead>): Promise<T[] | null> {
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
