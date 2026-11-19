/**
 * Summing money for the billing views: the periods list's totals
 * (./surface/periods.ts) and the period review's totals and tier amounts
 * (./surface/period-review-model.ts) add bills the same way, so a period's
 * total reads the same on both. Pure, with no server-only import, so the
 * review's model can use it.
 */
import { currencyFractionDigits } from "@/components/format/currency";

/**
 * An amount in the currency's minor units, rounded half away from zero on
 * the decimal the amount is written as, as the GUI's money values are
 * (toMinorUnits in src/lib/gui/fmt.ts): 1.005 is 101 cents, where scaling in
 * binary (1.005 * 100 = 100.49999999999999) would give 100. If fmt comes to
 * round differently, revisit, or a row and the total it adds to can disagree.
 */
function toMinorUnits(amount: number, digits: number): number {
  const [mantissa, exponent = "0"] = String(Math.abs(amount)).split("e");
  const v = Math.round(Number(`${mantissa}e${Number(exponent) + digits}`));
  return amount < 0 ? -v || 0 : v;
}

/**
 * Sums amounts in the currency's minor units: each amount is rounded to the
 * minor unit first, as its own row shows it, and the sum is exact. Adding
 * the floats instead leaves dust (0.1 + 0.2 is 0.30000000000000004) and
 * rounds once at the end, so a total could differ by a unit from the rows it
 * adds up.
 */
export function sumMoney(amounts: readonly number[], currency: string): number {
  const digits = currencyFractionDigits(currency);
  const minor = amounts.reduce((sum, a) => sum + toMinorUnits(a, digits), 0);
  return Number(`${minor}e-${digits}`);
}
