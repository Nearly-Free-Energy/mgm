import "server-only";

/**
 * A time budget for one contributed call (a watcher, a status loader, a
 * search), so one slow plugin cannot hold the others. The call is not
 * cancelled when its budget runs out; its late answer, or its error, is
 * ignored.
 */
export type BudgetOutcome<T> = { ok: true; value: T } | { ok: false; miss: "late" | "threw" };

export async function withinBudget<T>(work: () => Promise<T>, ms: number): Promise<BudgetOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BudgetOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, miss: "late" }), ms);
  });
  const done = (async () => work())().then(
    (value): BudgetOutcome<T> => ({ ok: true, value }),
    (): BudgetOutcome<T> => ({ ok: false, miss: "threw" }),
  );
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}
