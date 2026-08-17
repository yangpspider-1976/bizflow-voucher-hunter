import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/server/db";
import { AppError } from "@/server/errors";
import { requestSignInOtp, verifySignInOtp } from "@/server/otp";

// Sign-in OTP proves phone ownership at sign-in, campaign-agnostically. In
// non-production the code is returned so the flow can complete without live SMS.
describe("sign-in OTP", () => {
  beforeEach(async () => {
    await resetDb();
  });

  const phone = "+639171234567";

  it("verifies a phone with the code it was sent", async () => {
    const requested = await requestSignInOtp({ phone });
    expect(requested.sent).toBe(true);
    expect(requested.devCode).toMatch(/^\d{6}$/);

    const verified = await verifySignInOtp({ phone, code: requested.devCode! });
    expect(verified.phone).toBe(phone);
  });

  it("rejects an incorrect code", async () => {
    const requested = await requestSignInOtp({ phone });
    const wrong = requested.devCode === "000000" ? "111111" : "000000";
    await expect(verifySignInOtp({ phone, code: wrong })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("rejects verifying a number that never requested a code", async () => {
    await expect(
      verifySignInOtp({ phone: "+639998887777", code: "123456" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("consumes the code so it cannot be replayed", async () => {
    const requested = await requestSignInOtp({ phone });
    await verifySignInOtp({ phone, code: requested.devCode! });
    await expect(
      verifySignInOtp({ phone, code: requested.devCode! }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// The Play review account signs in with a fixed code because Google's reviewers
// cannot receive the SMS. See docs/PLAY_CONSOLE_ANSWERS.md §2.
describe("Play review account", () => {
  const reviewPhone = "+639171234567";
  const reviewCode = "482913";

  beforeEach(async () => {
    await resetDb();
    process.env.REVIEW_ACCOUNT_PHONE = "09171234567";
    process.env.REVIEW_ACCOUNT_OTP = reviewCode;
  });

  afterEach(() => {
    delete process.env.REVIEW_ACCOUNT_PHONE;
    delete process.env.REVIEW_ACCOUNT_OTP;
  });

  it("accepts the fixed code without an SMS ever being requested", async () => {
    const verified = await verifySignInOtp({
      phone: reviewPhone,
      code: reviewCode,
    });
    expect(verified.phone).toBe(reviewPhone);
  });

  it("matches the configured number in any accepted format", async () => {
    const requested = await requestSignInOtp({ phone: "0917 123 4567" });
    expect(requested.sent).toBe(true);
    // No real code was generated, so nothing may leak back to the client.
    expect(requested.devCode).toBeUndefined();
  });

  it("does not expire or consume the code across repeated reviews", async () => {
    await verifySignInOtp({ phone: reviewPhone, code: reviewCode });
    const second = await verifySignInOtp({ phone: reviewPhone, code: reviewCode });
    expect(second.phone).toBe(reviewPhone);
  });

  it("rejects a wrong code for the review number", async () => {
    await expect(
      verifySignInOtp({ phone: reviewPhone, code: "000000" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("leaves every other number on the real SMS path", async () => {
    const other = "+639998887777";
    await expect(
      verifySignInOtp({ phone: other, code: reviewCode }),
    ).rejects.toBeInstanceOf(AppError);

    const requested = await requestSignInOtp({ phone: other });
    expect(requested.devCode).toMatch(/^\d{6}$/);
    const verified = await verifySignInOtp({ phone: other, code: requested.devCode! });
    expect(verified.phone).toBe(other);
  });

  it("is inert when the code is unset, even with the phone set", async () => {
    delete process.env.REVIEW_ACCOUNT_OTP;
    await expect(
      verifySignInOtp({ phone: reviewPhone, code: reviewCode }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("is inert when the code is not six digits", async () => {
    process.env.REVIEW_ACCOUNT_OTP = "12345";
    await expect(
      verifySignInOtp({ phone: reviewPhone, code: "12345" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// The production developer account may also sign in with a fixed code, on the
// same terms as the reviewer above and through the same code path. The tools it
// carries are gated separately — see auth-hardening.test.ts.
describe("developer account sign-in", () => {
  const devPhone = "+639614073159";
  const devCode = "739204";
  const reviewPhone = "+639171234567";
  const reviewCode = "482913";

  beforeEach(async () => {
    await resetDb();
    process.env.DEV_ACCOUNT_PHONE = "09614073159";
    process.env.DEV_ACCOUNT_OTP = devCode;
  });

  afterEach(() => {
    delete process.env.DEV_ACCOUNT_PHONE;
    delete process.env.DEV_ACCOUNT_OTP;
    delete process.env.DEV_ACCOUNT_PHONE_2;
    delete process.env.DEV_ACCOUNT_OTP_2;
    delete process.env.REVIEW_ACCOUNT_PHONE;
    delete process.env.REVIEW_ACCOUNT_OTP;
  });

  it("accepts its fixed code without an SMS, and never consumes it", async () => {
    const requested = await requestSignInOtp({ phone: devPhone });
    expect(requested.sent).toBe(true);
    expect(requested.devCode).toBeUndefined();

    expect((await verifySignInOtp({ phone: devPhone, code: devCode })).phone).toBe(devPhone);
    expect((await verifySignInOtp({ phone: devPhone, code: devCode })).phone).toBe(devPhone);
  });

  it("rejects a wrong code", async () => {
    await expect(
      verifySignInOtp({ phone: devPhone, code: "000000" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("coexists with the review account rather than replacing it", async () => {
    process.env.REVIEW_ACCOUNT_PHONE = "09171234567";
    process.env.REVIEW_ACCOUNT_OTP = reviewCode;

    expect((await verifySignInOtp({ phone: devPhone, code: devCode })).phone).toBe(devPhone);
    expect((await verifySignInOtp({ phone: reviewPhone, code: reviewCode })).phone).toBe(
      reviewPhone,
    );
    // Each code belongs to its own number and must not open the other's.
    await expect(
      verifySignInOtp({ phone: devPhone, code: reviewCode }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("gives the second slot its own fixed code", async () => {
    const secondPhone = "+639123456789";
    const secondCode = "615037";
    process.env.DEV_ACCOUNT_PHONE_2 = "09123456789";
    process.env.DEV_ACCOUNT_OTP_2 = secondCode;

    expect((await verifySignInOtp({ phone: secondPhone, code: secondCode })).phone).toBe(
      secondPhone,
    );
    expect((await verifySignInOtp({ phone: devPhone, code: devCode })).phone).toBe(devPhone);
    // One slot's code must not open another slot's number.
    await expect(
      verifySignInOtp({ phone: secondPhone, code: devCode }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("stays on the SMS path when only the phone is configured", async () => {
    // The intended setup for a number you actually hold: tools without a
    // password that never expires.
    delete process.env.DEV_ACCOUNT_OTP;
    await expect(
      verifySignInOtp({ phone: devPhone, code: devCode }),
    ).rejects.toBeInstanceOf(AppError);

    const requested = await requestSignInOtp({ phone: devPhone });
    expect(requested.devCode).toMatch(/^\d{6}$/);
    expect((await verifySignInOtp({ phone: devPhone, code: requested.devCode! })).phone).toBe(
      devPhone,
    );
  });
});
