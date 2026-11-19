/**
 * sumMoney (../money.ts): the periods list and the period review add a
 * period's bills in the currency's minor units, so neither shows float dust
 * and both show the same total.
 */
import { describe, expect, it } from "vitest";
import { sumMoney } from "../money";

describe("sumMoney", () => {
  it("leaves no float dust in a currency with cents", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([0.1, 0.2], "USD")).toBe(0.3);
    expect(sumMoney(Array.from({ length: 10 }, () => 0.1), "USD")).toBe(1);
    expect(sumMoney([19.99, 0.01, 1234.56], "USD")).toBe(1254.56);
  });

  it("rounds each amount to the minor unit first, as its own row shows it", () => {
    // UGX has no minor unit: 1250.5 reads 1,251, so two of them total 2,502, not 2,501.
    expect(sumMoney([1250.5, 1250.5], "UGX")).toBe(2502);
    // On the decimal written, not in binary: 1.005 * 100 is 100.49999999999999.
    expect(sumMoney([1.005], "USD")).toBe(1.01);
  });

  it("sums amounts too large to print without an exponent", () => {
    expect(String(1e21)).toBe("1e+21");
    expect(sumMoney([1e21], "UGX")).toBe(1e21);
    expect(sumMoney([1e21, 1e21], "UGX")).toBe(2e21);
    // 1e19 dollars is 1e21 cents.
    expect(sumMoney([1e19, 0.01], "USD")).toBe(1e19);
    expect(sumMoney([5e18, 5e18], "USD")).toBe(1e19);
    expect(Number.isNaN(sumMoney([1e19, 1e19], "USD"))).toBe(false);
  });

  it("sums nothing to zero, and keeps negative amounts", () => {
    expect(sumMoney([], "UGX")).toBe(0);
    expect(sumMoney([-0.1, -0.2], "USD")).toBe(-0.3);
    expect(sumMoney([0.3, -0.1], "USD")).toBe(0.2);
  });
});
