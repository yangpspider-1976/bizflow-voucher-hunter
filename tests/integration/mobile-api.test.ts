import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieValues = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      const value = cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      if (value) cookieValues.set(name, value);
      else cookieValues.delete(name);
    },
  }),
}));

import { GET as listCampaigns } from "@/app/api/public/campaigns/route";
import { POST as drawVoucher } from "@/app/api/public/hunt/attempt/route";
import { POST as selectVoucher } from "@/app/api/public/hunt/select/route";
import { GET as listAttemptSlots } from "@/app/api/public/hunt/slots/route";
import { POST as startHuntRoute } from "@/app/api/public/hunt/start/route";
import { POST as loadRewardWallet } from "@/app/api/public/rewards/wallet/route";
import { POST as signOutRoute } from "@/app/api/public/signin/signout/route";
import { POST as verifyOtpRoute } from "@/app/api/public/signin/verify-otp/route";
import { GET as listVouchers } from "@/app/api/public/vouchers/route";
import { getDb, one, resetDb } from "@/server/db";
import { requestSignInOtp } from "@/server/otp";
import { huntAndSelect } from "../helpers";

type ApiResponse<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: { code: string; message: string; details?: unknown };
    };

async function responseBody<T>(response: Response) {
  return (await response.json()) as ApiResponse<T>;
}

async function issueMobileToken(phone: string) {
  const challenge = await requestSignInOtp({ phone });
  const response = await verifyOtpRoute(
    new Request("http://localhost/api/public/signin/verify-otp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client": "mobile",
      },
      body: JSON.stringify({ phone, code: challenge.devCode }),
    }),
  );
  const body = await responseBody<{ phone: string; token: string }>(response);
  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  if (!body.success) throw new Error(body.error.message);
  return body.data.token;
}

function bearerRequest(
  url: string,
  token: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { ...init, headers });
}

describe("Phase 1 mobile API", () => {
  const phone = "+639171234567";

  beforeEach(async () => {
    cookieValues.clear();
    await resetDb();
  });

  it("issues a bearer token after OTP without storing the raw credential", async () => {
    const token = await issueMobileToken(phone);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const db = await getDb();
    const row = await one(
      db,
      "SELECT token_hash, phone, expires_at FROM customer_tokens LIMIT 1",
    );
    expect(row?.phone).toBe(phone);
    expect(row?.token_hash).not.toBe(token);
    expect(String(row?.token_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(String(row?.expires_at)).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("authorizes a hunt endpoint with a valid bearer token", async () => {
    const token = await issueMobileToken(phone);
    cookieValues.clear();
    const response = await startHuntRoute(
      bearerRequest(
        "http://localhost/api/public/hunt/start",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            sessionId: "mobile-session",
            name: "Mobile User",
          }),
        },
      ),
    );
    const body = await responseBody<{ user: { phone: string } }>(response);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    if (body.success) expect(body.data.user.phone).toBe(phone);
  });

  it.each([
    ["an invalid bearer token", "invalid-token"],
    ["a malformed authorization header", ""],
  ])("rejects %s", async (_label, token) => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "authorization",
      token ? `Bearer ${token}` : "Token malformed",
    );
    const response = await startHuntRoute(
      new Request("http://localhost/api/public/hunt/start", {
        method: "POST",
        headers,
        body: JSON.stringify({
          campaignSlug: "july-dinner",
          sessionId: "unauthorized-session",
        }),
      }),
    );
    const body = await responseBody<unknown>(response);
    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      error: { code: "E-CUSTOMER-AUTH" },
    });
  });

  it("rejects a request with neither a bearer token nor auth cookies", async () => {
    const response = await startHuntRoute(
      new Request("http://localhost/api/public/hunt/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaignSlug: "july-dinner",
          sessionId: "signed-out-session",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("revokes the current bearer token on sign out", async () => {
    const token = await issueMobileToken(phone);
    await signOutRoute(
      bearerRequest(
        "http://localhost/api/public/signin/signout",
        token,
        { method: "POST" },
      ),
    );
    const response = await startHuntRoute(
      bearerRequest(
        "http://localhost/api/public/hunt/start",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            sessionId: "revoked-session",
          }),
        },
      ),
    );
    expect(response.status).toBe(401);
  });

  it("invalidates issued mobile tokens when data is reset", async () => {
    const token = await issueMobileToken(phone);
    await resetDb();
    const response = await startHuntRoute(
      bearerRequest(
        "http://localhost/api/public/hunt/start",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            sessionId: "post-reset-session",
          }),
        },
      ),
    );
    expect(response.status).toBe(401);
  });

  it("lists active campaigns for the mobile directory", async () => {
    // Signed out: the directory is public, and every card comes back with the
    // level gate computed for the floor of the ladder.
    const response = await listCampaigns(new Request("http://localhost/api/public/campaigns"));
    const body = await responseBody<
      Array<{
        campaign: { slug: string };
        businessName: string;
        businessLogo: string;
        businessIndustry: string;
      }>
    >(response);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    if (body.success) {
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toMatchObject({
        campaign: { slug: expect.any(String) },
        businessName: expect.any(String),
        businessLogo: expect.any(String),
        businessIndustry: expect.any(String),
      });
    }
  });

  it("returns all server-backed vouchers owned by the bearer phone", async () => {
    await huntAndSelect({
      campaignSlug: "july-dinner",
      phone,
      sessionId: "mobile-voucher-session",
      draws: 1,
    });
    const token = await issueMobileToken(phone);
    cookieValues.clear();
    const response = await listVouchers(
      bearerRequest("http://localhost/api/public/vouchers", token),
    );
    const body = await responseBody<
      Array<{
        voucher: { id: string; userId: string; qrToken: string };
        slot: { id: string; startTime: string; endTime: string };
        campaignSlug: string;
        campaignTitle: string;
        businessName: string;
      }>
    >(response);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    if (body.success) {
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        voucher: {
          id: expect.any(String),
          userId: expect.any(String),
          qrToken: expect.any(String),
        },
        slot: {
          id: expect.any(String),
          startTime: expect.any(String),
          endTime: expect.any(String),
        },
        campaignSlug: "july-dinner",
        campaignTitle: expect.any(String),
        businessName: expect.any(String),
      });
    }
  });

  it("drives the complete mobile journey with one bearer token", async () => {
    const token = await issueMobileToken(phone);
    cookieValues.clear();
    const sessionId = "complete-mobile-journey";

    const startResponse = await startHuntRoute(
      bearerRequest(
        "http://localhost/api/public/hunt/start",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            sessionId,
            name: "Mobile Journey",
          }),
        },
      ),
    );
    expect(startResponse.status).toBe(200);

    const attemptResponse = await drawVoucher(
      bearerRequest(
        "http://localhost/api/public/hunt/attempt",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            sessionId,
          }),
        },
      ),
    );
    const attemptBody = await responseBody<{ id: string }>(attemptResponse);
    expect(attemptBody.success).toBe(true);
    if (!attemptBody.success) throw new Error(attemptBody.error.message);

    const slotsResponse = await listAttemptSlots(
      bearerRequest(
        `http://localhost/api/public/hunt/slots?campaignSlug=july-dinner&attemptId=${attemptBody.data.id}`,
        token,
      ),
    );
    const slotsBody = await responseBody<{
      slots: Array<{ id: string }>;
    }>(slotsResponse);
    expect(slotsBody.success).toBe(true);
    if (!slotsBody.success) throw new Error(slotsBody.error.message);
    expect(slotsBody.data.slots.length).toBeGreaterThan(0);

    const selectResponse = await selectVoucher(
      bearerRequest(
        "http://localhost/api/public/hunt/select",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campaignSlug: "july-dinner",
            attemptId: attemptBody.data.id,
            slotId: slotsBody.data.slots[0].id,
            sessionId,
            name: "Mobile Journey",
          }),
        },
      ),
    );
    const selectBody = await responseBody<{
      voucher: { voucherCode: string };
    }>(selectResponse);
    expect(selectResponse.status).toBe(200);
    expect(selectBody.success).toBe(true);

    const vouchersResponse = await listVouchers(
      bearerRequest("http://localhost/api/public/vouchers", token),
    );
    const vouchersBody = await responseBody<
      Array<{ voucher: { voucherCode: string } }>
    >(vouchersResponse);
    expect(vouchersBody.success).toBe(true);
    if (
      selectBody.success &&
      vouchersBody.success
    ) {
      expect(vouchersBody.data[0].voucher.voucherCode).toBe(
        selectBody.data.voucher.voucherCode,
      );
    }

    const walletResponse = await loadRewardWallet(
      bearerRequest(
        "http://localhost/api/public/rewards/wallet",
        token,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Mobile Journey" }),
        },
      ),
    );
    const walletBody = await responseBody<{
      wallet: { phone: string };
      walletSecret: string;
      balance: string;
      dailyStatus: {
        appUseAwarded: boolean;
        referralAwarded: boolean;
        earnedToday: string;
      };
    }>(walletResponse);
    expect(walletResponse.status).toBe(200);
    expect(walletBody.success).toBe(true);
    if (walletBody.success) {
      expect(walletBody.data.wallet.phone).toBe(phone);
      expect(walletBody.data.walletSecret).toMatch(/^rwsecret_/);
      // Today's app-use award is a 1-10 LP draw, so the balance is pinned to
      // the band and to the status that reports it, not to a fixed figure.
      expect(walletBody.data.balance).toMatch(/^([1-9]|10) LP$/);
      expect(walletBody.data.dailyStatus).toMatchObject({
        appUseAwarded: true,
        referralAwarded: false,
        earnedToday: walletBody.data.balance,
      });
    }
  });
});
