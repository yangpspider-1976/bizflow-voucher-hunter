import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { MAX_MONEY_CENTAVOS } from "@/lib/limits";
import { loyaltyPointsToCentavos, moneyToCentavos } from "@/server/rewards-network";

/**
 * Every amount in the rewards domain is parsed here, and every one of them ends
 * up in an int4 column. The regression this guards is not a rejected input — it
 * is an accepted one: a mistyped bill used to store fine and then take down
 * whichever page next scaled it, as a 22003 from inside a UNION.
 */
describe("money limits", () => {
  it("parses an ordinary amount", () => {
    expect(moneyToCentavos("1000")).toBe(100_000);
    expect(moneyToCentavos("1,234.56")).toBe(123_456);
    expect(moneyToCentavos(20)).toBe(2_000);
  });

  it("accepts the ceiling itself", () => {
    expect(moneyToCentavos("10000000")).toBe(MAX_MONEY_CENTAVOS);
  });

  it("refuses a centavo past the ceiling", () => {
    expect(() => moneyToCentavos("10000000.01")).toThrow(AppError);
  });

  it("answers with a 400 naming the field, not a 500 from the database", () => {
    try {
      moneyToCentavos("999999999", "purchase amount");
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).message).toContain("purchase amount");
    }
  });

  it("measures the magnitude, so a mistyped debit is caught too", () => {
    // Deposit adjustments are signed, and -₱2,000,000,000 overflows the column
    // exactly as readily as the positive figure does.
    expect(() => moneyToCentavos(-2_000_000_000)).toThrow(AppError);
  });

  it("bounds LP amounts by the same ceiling", () => {
    expect(loyaltyPointsToCentavos("500 LP")).toBe(50_000);
    expect(() => loyaltyPointsToCentavos("20000000 LP")).toThrow(AppError);
  });

  it("still refuses what was never a number", () => {
    expect(() => moneyToCentavos("abc")).toThrow(AppError);
    expect(() => moneyToCentavos(Number.POSITIVE_INFINITY)).toThrow(AppError);
  });
});
