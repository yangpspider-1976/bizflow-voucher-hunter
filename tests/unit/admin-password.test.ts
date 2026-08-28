import { describe, expect, it } from "vitest";
import { isPasswordTooShort, MIN_PASSWORD_LENGTH } from "@/lib/admin-password";

// The console password rule, on its own: the module that enforces it also
// hashes and stores, which needs a database the unit suite does not have.
describe("console account password rule", () => {
  it("accepts a password at the minimum length", () => {
    expect(isPasswordTooShort("a".repeat(MIN_PASSWORD_LENGTH))).toBe(false);
    expect(isPasswordTooShort("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(true);
  });

  it("does not let spaces make up the length", () => {
    expect(isPasswordTooShort(" ".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isPasswordTooShort(" ".repeat(MIN_PASSWORD_LENGTH * 2))).toBe(true);
    expect(isPasswordTooShort("\t\n  \t\n  \t\n")).toBe(true);
    expect(isPasswordTooShort("   pass   ")).toBe(true);
  });

  it("counts spaces inside a passphrase, which are ordinary characters", () => {
    expect(isPasswordTooShort("correct horse battery")).toBe(false);
    expect(isPasswordTooShort("  correct horse battery  ")).toBe(false);
  });

  it("treats an empty password as too short", () => {
    expect(isPasswordTooShort("")).toBe(true);
  });
});
