/**
 * Captures the dashboard screenshots the Word guides embed.
 *
 * The guides are built from scripts, so the pictures in them should be too:
 * a screenshot taken by hand is a screenshot nobody can retake the same way
 * when the UI moves. Each shot lands in docs/images/ under the filename the
 * builders' SHOTS maps already look for, so re-running a builder picks it up
 * with no edit.
 *
 * Needs the dev server up, with a seeded database and dev tools enabled (the
 * bootstrap logins below only exist when they are):
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/voucher_hunt_shots \
 *   ADMIN_SESSION_SECRET=... npm run dev
 *
 *   node scripts/capture-guide-screenshots.mjs
 *
 * VOUCHER_CODE should be an issued, unredeemed voucher belonging to the staff
 * account's business, or the validation-result shot is skipped. Run a hunt
 * against the seeded campaign to make one.
 *
 * Playwright's own browsers are not downloaded on every machine here, so this
 * drives the installed Chrome via `channel: "chrome"`.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES = path.join(ROOT, "docs", "images");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VOUCHER_CODE = process.env.VOUCHER_CODE ?? "";
const CAMPAIGN = process.env.CAMPAIGN_SLUG ?? "july-dinner";
const BUSINESS = process.env.BUSINESS_ID ?? "biz_demo_restaurant";

// Read from the environment rather than written down here: these are whatever
// the local .env sets, and the fallbacks are only the dev-tools defaults the
// login route itself uses when .env says nothing.
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "admin@bizflow.local",
  password: process.env.ADMIN_PASSWORD ?? "admin-password",
};
const STAFF = {
  email: process.env.STAFF_EMAIL ?? "staff@bizflow.local",
  password: process.env.STAFF_PASSWORD ?? "staff-password",
};

/** Campaign-scoped URL, so a page opens on the campaign we mean. */
const scoped = (route) =>
  `${BASE}${route}?business=${BUSINESS}&campaign=${CAMPAIGN}`;

const taken = [];
const skipped = [];

async function shot(page, name) {
  // Let fonts and any just-loaded panel settle, or the first shot of a run
  // catches a half-painted table.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(IMAGES, `${name}.png`) });
  taken.push(name);
  console.log(`  captured ${name}.png`);
}

/** Waits for a page's own heading, so a shot is never of a skeleton. */
async function open(page, url, heading) {
  await page.goto(url, { waitUntil: "networkidle" });
  if (heading) {
    await page.getByRole("heading", { name: heading }).first().waitFor({
      timeout: 15000,
    });
  }
}

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole("button", { name: /sign in to dashboard/i }).click();
  // The form navigates with router.replace, which fires no load event, so
  // waiting on the URL alone hangs. Race the destination against the form's
  // own error line, so a wrong password fails loudly instead of timing out.
  const failed = page.locator(".admin-login-error");
  await Promise.race([
    page.waitForURL(/\/dashboard/, { waitUntil: "commit", timeout: 20000 }),
    failed.waitFor({ timeout: 20000 }).then(async () => {
      throw new Error(`sign-in refused for ${who.email}: ${await failed.innerText()}`);
    }),
  ]);
  await page.waitForLoadState("networkidle");
}

async function signOut(page) {
  // Cheaper and steadier than driving the account menu: drop the session
  // cookie and the next navigation is anonymous.
  await page.context().clearCookies();
}

async function main() {
  mkdirSync(IMAGES, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    console.log("Login screen");
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    await shot(page, "staff-00-login");

    console.log("Staff view");
    await signIn(page, STAFF);
    await open(page, scoped("/dashboard"), undefined);
    await shot(page, "staff-04-dashboard");

    await open(page, `${BASE}/dashboard/billing`, "LP Billing");
    await shot(page, "staff-05-billing");

    // Submitting a request here is what puts a Pending row on both this page
    // and the admin's review panel, so the two shots below are the same
    // request seen from each side.
    await open(page, scoped("/dashboard/slots"), "Slots");
    const date = new Date();
    date.setDate(date.getDate() + 14);
    const iso = date.toISOString().slice(0, 10);
    try {
      // "Request Slot" is a link to a dedicated route, not a button, so go
      // straight there rather than hunting for a control on the list page.
      await open(page, scoped("/dashboard/slots/new"), undefined);
      await page.locator('input[type="date"]').first().fill(iso);
      const times = page.locator('input[type="time"]');
      await times.nth(0).fill("15:00");
      await times.nth(1).fill("17:00");
      await page.locator('input[type="number"]').first().fill("12");
      await page
        .getByRole("button", { name: /^(request|submit|save|add|create)/i })
        .first()
        .click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
    } catch (error) {
      console.log(`  could not submit a slot request: ${error.message}`);
    }
    await open(page, scoped("/dashboard/slots"), "Slots");
    await shot(page, "staff-06-requests");

    if (VOUCHER_CODE) {
      await open(page, `${BASE}/dashboard/staff`, "Scan & Redeem");
      await page
        .locator('input[placeholder*="BF20"], input[type="text"]')
        .first()
        .fill(VOUCHER_CODE);
      await page.getByRole("button", { name: /validate voucher/i }).click();
      await page
        .getByRole("heading", { name: /validation result/i })
        .waitFor({ timeout: 20000 });
      await shot(page, "staff-03-result");
    } else {
      skipped.push("staff-03-result (no VOUCHER_CODE given)");
    }

    console.log("Admin view");
    await signOut(page);
    await signIn(page, ADMIN);

    await open(page, `${BASE}/dashboard/businesses/new`, undefined);
    await shot(page, "admin-01-business");

    await open(page, `${BASE}/dashboard/campaigns/new`, undefined);
    await shot(page, "admin-02-campaign");

    await open(page, scoped("/dashboard/slots"), "Slots");
    await shot(page, "admin-03-slots");
    // The staff request submitted above is on this page too, under its own
    // panel with the approve and reject actions.
    const staffPanel = page
      .getByRole("heading", { name: /staff slot requests/i })
      .first();
    if (await staffPanel.count()) {
      await staffPanel.scrollIntoViewIfNeeded();
      await shot(page, "admin-05-requests");
    } else {
      skipped.push("admin-05-requests (no staff request panel found)");
    }

    await open(page, scoped("/dashboard/vouchers/new"), undefined);
    await shot(page, "admin-04-pool");

    await open(page, `${BASE}/dashboard/team`, "Team");
    await shot(page, "admin-06-team");

    await open(page, `${BASE}/dashboard/gamification/missions`, "Missions");
    await shot(page, "admin-07-missions");

    await open(page, `${BASE}/dashboard/settings`, "Settings");
    const danger = page.getByRole("heading", { name: /danger zone/i }).first();
    if (await danger.count()) await danger.scrollIntoViewIfNeeded();
    await shot(page, "admin-08-settings");
  } finally {
    await browser.close();
  }

  console.log(`\n${taken.length} captured`);
  if (skipped.length) {
    console.log(`${skipped.length} skipped:`);
    for (const line of skipped) console.log(`  - ${line}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
