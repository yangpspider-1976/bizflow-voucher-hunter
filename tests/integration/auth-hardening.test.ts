import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/server/db";
import {
  assertDevToolsEnabledFor,
  devToolsEnabled,
  devToolsEnabledFor,
  isDevAccountPhone,
} from "@/server/dev-tools";
import { requestSignInOtp, verifySignInOtp } from "@/server/otp";
import { clientIp } from "@/server/rate-limit";
import {
  grantDevBusinessLoyaltyPoints,
  grantDevLoyaltyPoints,
} from "@/server/rewards-network";
import { POST as requestOtpRoute } from "@/app/api/public/signin/request-otp/route";
import { POST as verifyOtpRoute } from "@/app/api/public/signin/verify-otp/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as devPurchaseRoute } from "@/app/api/public/rewards/dev-purchase/route";
import { POST as devCollectRoute } from "@/app/api/public/rewards/dev-collect/route";

const PHONE = "+639170001111";

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The wrong six-digit code, whatever the right one happens to be. */
function wrongCode(actual: string | undefined) {
  return actual === "000000" ? "111111" : "000000";
}

describe("sign-in OTP brute force", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("burns the challenge after five wrong codes instead of allowing a million", async () => {
    const issued = await requestSignInOtp({ phone: PHONE });
    const bad = wrongCode(issued.devCode);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verifySignInOtp({ phone: PHONE, code: bad })).rejects.toMatchObject({
        code: "E-OTP-MISMATCH",
      });
    }

    // Sixth guess: the challenge is spent, so even the *correct* code no longer
    // works. Without this the code stayed guessable for its full 5-minute life.
    await expect(
      verifySignInOtp({ phone: PHONE, code: issued.devCode! }),
    ).rejects.toMatchObject({ code: "E-OTP-404" });
  });

  it("caps how many codes one number can be sent, however many addresses ask", async () => {
    for (let sent = 0; sent < 5; sent += 1) {
      await expect(requestSignInOtp({ phone: PHONE })).resolves.toMatchObject({ sent: true });
    }
    await expect(requestSignInOtp({ phone: PHONE })).rejects.toMatchObject({
      code: "E-OTP-THROTTLED",
    });
  });

  it("invalidates an outstanding code when a new one is requested", async () => {
    const first = await requestSignInOtp({ phone: PHONE });
    await requestSignInOtp({ phone: PHONE });

    // The superseded code must not still open the account: leaving old
    // challenges live multiplied the number of 20-bit targets per number.
    await expect(
      verifySignInOtp({ phone: PHONE, code: first.devCode! }),
    ).rejects.toMatchObject({ code: "E-OTP-MISMATCH" });
  });

  it("rate-limits verification per phone, not only per source address", async () => {
    await requestSignInOtp({ phone: PHONE });

    let throttled = false;
    // Every request carries a different forwarded address, which is exactly the
    // bypass the old limiter had: the attacker chooses that header.
    for (let attempt = 0; attempt < 14 && !throttled; attempt += 1) {
      const response = await verifyOtpRoute(
        jsonRequest(
          "http://localhost/api/public/signin/verify-otp",
          { phone: PHONE, code: "000000" },
          { "x-forwarded-for": `203.0.113.${attempt}` },
        ),
      );
      if (response.status === 429) throttled = true;
    }
    expect(throttled).toBe(true);
  });

  it("rate-limits code requests per phone across rotating addresses", async () => {
    let throttled = false;
    for (let attempt = 0; attempt < 8 && !throttled; attempt += 1) {
      const response = await requestOtpRoute(
        jsonRequest(
          "http://localhost/api/public/signin/request-otp",
          { phone: "+639170002222" },
          { "x-forwarded-for": `198.51.100.${attempt}` },
        ),
      );
      if (response.status === 429) throttled = true;
    }
    expect(throttled).toBe(true);
  });
});

describe("client address resolution", () => {
  it("reads the hop our proxy appended, not the one the caller supplied", () => {
    // A caller sending their own X-Forwarded-For puts their value first; the
    // proxy appends the address it actually saw. Taking [0] let anyone pick
    // their own rate-limit bucket and rotate it per request.
    const spoofed = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.7" },
    });
    expect(clientIp(spoofed)).toBe("203.0.113.7");
  });

  it("prefers the platform header that cannot be appended to", () => {
    const request = new Request("http://localhost/", {
      headers: {
        "x-forwarded-for": "1.1.1.1, 9.9.9.9",
        "x-vercel-forwarded-for": "203.0.113.9",
      },
    });
    expect(clientIp(request)).toBe("203.0.113.9");
  });

  it("never falls past the leftmost hop into caller-controlled territory", () => {
    // More trusted hops configured than the header actually has: clamp to the
    // first entry rather than reading undefined and bucketing everyone together.
    const previous = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "5";
    try {
      const request = new Request("http://localhost/", {
        headers: { "x-forwarded-for": "203.0.113.4" },
      });
      expect(clientIp(request)).toBe("203.0.113.4");
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = previous;
    }
  });
});

describe("console login brute force", () => {
  beforeEach(async () => {
    process.env.ADMIN_SESSION_SECRET =
      "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  it("throttles password guessing against one account across addresses", async () => {
    let throttled = false;
    for (let attempt = 0; attempt < 14 && !throttled; attempt += 1) {
      const response = await loginRoute(
        jsonRequest(
          "http://localhost/api/auth/login",
          { email: "admin@bizflow.local", password: `guess-${attempt}` },
          { "x-forwarded-for": `192.0.2.${attempt}` },
        ),
      );
      if (response.status === 429) throttled = true;
    }
    expect(throttled).toBe(true);
  });
});

describe("dev-only tooling gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays closed for an unrecognised environment such as a preview deploy", () => {
    vi.stubEnv("ENABLE_DEV_TOOLS", undefined);

    // These are the values that made the old `NODE_ENV !== "production"` gate
    // hand out free LP, forced draws and a published-password super-admin login.
    for (const value of ["preview", "staging", undefined]) {
      vi.stubEnv("NODE_ENV", value);
      expect(devToolsEnabled()).toBe(false);
    }
  });

  it("stays closed in production even with the opt-in flag set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DEV_TOOLS", "true");
    expect(devToolsEnabled()).toBe(false);
  });

  it("opens for development, test, and an explicit opt-in", () => {
    vi.stubEnv("ENABLE_DEV_TOOLS", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(devToolsEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "test");
    expect(devToolsEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "staging");
    vi.stubEnv("ENABLE_DEV_TOOLS", "true");
    expect(devToolsEnabled()).toBe(true);
  });

  it("refuses to mint Loyalty Points once the gate is closed", async () => {
    vi.stubEnv("ENABLE_DEV_TOOLS", undefined);
    vi.stubEnv("NODE_ENV", "preview");

    // The whole point: this endpoint creates spendable balance no partner has
    // been billed for, and "preview" used to read as not-production.
    await expect(
      grantDevLoyaltyPoints({ phone: PHONE, amount: "500" }),
    ).rejects.toMatchObject({ code: "E-DEV-ONLY" });
  });
});

// A handful of customer numbers carry the self-scoped tools into production,
// where the deployment-wide gate above can never open. That covers the hunt
// helpers and the two LP grants, which touch only the caller's own wallet.
// Anything that bills a real partner stays shut for them.
describe("production developer account", () => {
  const DEV_PHONE = "+639614073159";

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DEV_TOOLS", undefined);
    vi.stubEnv("DEV_ACCOUNT_PHONE", "09614073159");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens the hunt tools for its own number in production", () => {
    expect(devToolsEnabled()).toBe(false);
    expect(devToolsEnabledFor(DEV_PHONE)).toBe(true);
    expect(() => assertDevToolsEnabledFor(DEV_PHONE, "Hunt reset")).not.toThrow();
  });

  it("matches the configured number in any accepted format", () => {
    for (const spelling of ["09614073159", "+639614073159", "639614073159", "0961 407 3159"]) {
      expect(devToolsEnabledFor(spelling)).toBe(true);
    }
  });

  it("leaves every other customer where they were", () => {
    expect(devToolsEnabledFor(PHONE)).toBe(false);
    expect(devToolsEnabledFor(null)).toBe(false);
    expect(devToolsEnabledFor("")).toBe(false);
    // A near-miss must not pass: this is the whole authorisation check.
    expect(devToolsEnabledFor("+639614073158")).toBe(false);
    expect(() => assertDevToolsEnabledFor(PHONE, "Hunt reset")).toThrow();
  });

  it("is inert when the number is unset or unparseable", () => {
    vi.stubEnv("DEV_ACCOUNT_PHONE", undefined);
    expect(devToolsEnabledFor(DEV_PHONE)).toBe(false);
    // Not a PH mobile number: a typo in the env var must fail closed rather
    // than match whatever else happens to normalise to null.
    vi.stubEnv("DEV_ACCOUNT_PHONE", "not-a-number");
    expect(devToolsEnabledFor(DEV_PHONE)).toBe(false);
    expect(devToolsEnabledFor("not-a-number")).toBe(false);
  });

  it("opens the tools for the second slot, without closing the first", () => {
    vi.stubEnv("DEV_ACCOUNT_PHONE_2", "09123456789");
    expect(devToolsEnabledFor("+639123456789")).toBe(true);
    expect(devToolsEnabledFor(DEV_PHONE)).toBe(true);
    expect(devToolsEnabledFor(PHONE)).toBe(false);
  });

  it("lets a later slot stand on its own when the first is unset", () => {
    // The slots are independent: skipping one must not shift the others along
    // or disable them.
    vi.stubEnv("DEV_ACCOUNT_PHONE", undefined);
    vi.stubEnv("DEV_ACCOUNT_PHONE_2", "09123456789");
    expect(devToolsEnabledFor("+639123456789")).toBe(true);
    expect(devToolsEnabledFor(DEV_PHONE)).toBe(false);
  });

  it("is the only thing that shows a client the dev panel", () => {
    // What GET /api/public/signin/session returns, and the whole difference
    // between the two answers: a development deployment opens the tools for
    // everyone who signs in, but the panel belongs to the developer account
    // alone — an ordinary test account on a dev build was seeing it too.
    vi.stubEnv("NODE_ENV", "development");
    expect(devToolsEnabledFor(PHONE)).toBe(true);
    expect(isDevAccountPhone(PHONE)).toBe(false);
    expect(isDevAccountPhone(DEV_PHONE)).toBe(true);
    expect(isDevAccountPhone(null)).toBe(false);
  });

  it("opens both LP grants for its own wallet in production", () => {
    // Global pot and partner bucket buy different things, so the shop is only
    // half testable if one of them is shut. Both mint points without writing a
    // partner liability, which is what puts them on this side of the line.
    expect(devToolsEnabled()).toBe(false);
    expect(() =>
      assertDevToolsEnabledFor(DEV_PHONE, "Granting Loyalty Points"),
    ).not.toThrow();
  });

  it("still refuses to mint Loyalty Points for every other customer", async () => {
    await expect(
      grantDevLoyaltyPoints({ phone: PHONE, amount: "500" }),
    ).rejects.toMatchObject({ code: "E-DEV-ONLY" });
    await expect(
      grantDevBusinessLoyaltyPoints({
        phone: PHONE,
        businessId: "biz_dev_tools_test",
        amount: "500",
      }),
    ).rejects.toMatchObject({ code: "E-DEV-ONLY" });
  });

  it("still refuses the tools that bill a partner, this account included", async () => {
    // The line between the two tiers: a grant moves this wallet's own balance,
    // while a simulated scan or collection writes rows a real partner is
    // invoiced for. Those refuse before they ever look at who is asking.
    for (const route of [devPurchaseRoute, devCollectRoute]) {
      // The gate runs before rate limiting and before the session lookup, so an
      // empty body never gets that far.
      const response = await route(
        jsonRequest("https://example.test/api/public/rewards/dev", {}),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("E-DEV-ONLY");
    }
  });
});
