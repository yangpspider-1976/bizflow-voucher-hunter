/**
 * Captures the customer-app screenshots the Customer Guide embeds.
 *
 * The companion to capture-guide-screenshots.mjs, which does the dashboard.
 * Same idea: the guide is built from a script, so its pictures should be too.
 *
 * NOTE: not yet run anywhere — no Android build completes on the Windows dev
 * machine (ninja MAX_PATH, see docs/images/README.md). Written against the
 * screens and i18n strings; expect to adjust selectors on first real run.
 *
 * Needs a booted emulator with the dev client installed, Metro running against
 * the local API, and the dev server up with dev tools enabled — the sign-in
 * screen prints the OTP on screen only when they are, and this script reads it
 * from there rather than from a handset.
 *
 *   npm run emulator:dev          # Metro -> http://10.0.2.2:3000
 *   node scripts/capture-app-screenshots.mjs
 *
 * Elements are found by dumping the view hierarchy and matching on text, not
 * by tapping fixed coordinates: the tab bar moves with the device and a
 * coordinate script silently taps the wrong thing when it does.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES = path.join(ROOT, "docs", "images");
const ADB =
  process.env.ADB_PATH ??
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Android",
    "Sdk",
    "platform-tools",
    "adb.exe",
  );
const SERIAL = process.env.ANDROID_SERIAL ?? "emulator-5554";
const PHONE = process.env.CAPTURE_PHONE ?? "09171234567";
const PACKAGE = process.env.APP_PACKAGE ?? "com.voucherhunt.mobile";

const adb = (args, opts = {}) =>
  execFileSync(ADB, ["-s", SERIAL, ...args], {
    encoding: opts.binary ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenshot(name) {
  const png = adb(["exec-out", "screencap", "-p"], { binary: true });
  writeFileSync(path.join(IMAGES, `${name}.png`), png);
  console.log(`  captured ${name}.png`);
}

/** The current view hierarchy as XML. */
function dump() {
  adb(["shell", "uiautomator", "dump", "/sdcard/ui.xml"]);
  return adb(["shell", "cat", "/sdcard/ui.xml"]);
}

/**
 * Centre of the first node whose text or content-desc matches, or null.
 * Matching is case-insensitive and substring-based, because React Native
 * renders a lot of text nodes with surrounding whitespace.
 */
function find(xml, needle) {
  const wanted = needle.toLowerCase();
  const nodes = xml.match(/<node[^>]*>/g) ?? [];
  for (const node of nodes) {
    const text = (node.match(/text="([^"]*)"/)?.[1] ?? "").toLowerCase();
    const desc = (node.match(/content-desc="([^"]*)"/)?.[1] ?? "").toLowerCase();
    if (!text.includes(wanted) && !desc.includes(wanted)) continue;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }
  return null;
}

async function tap(needle, { timeout = 15000, label = needle } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const point = find(dump(), needle);
    if (point) {
      adb(["shell", "input", "tap", String(point.x), String(point.y)]);
      await sleep(1200);
      return true;
    }
    await sleep(800);
  }
  throw new Error(`could not find "${label}" on screen`);
}

async function waitFor(needle, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (find(dump(), needle)) return true;
    await sleep(800);
  }
  throw new Error(`"${needle}" never appeared`);
}

async function main() {
  mkdirSync(IMAGES, { recursive: true });

  console.log("Launching the app");
  adb(["shell", "am", "force-stop", PACKAGE]);
  adb([
    "shell",
    "monkey",
    "-p",
    PACKAGE,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
  await sleep(9000);

  // --- Sign in -----------------------------------------------------------
  await waitFor("mobile number", 45000);
  await tap("09", { label: "the mobile number field" });
  adb(["shell", "input", "text", PHONE]);
  await sleep(600);
  // Typed but not yet sent, which is the state the guide describes.
  screenshot("customer-00-signin");

  await tap("send code");
  await waitFor("verification code", 30000);

  // Dev builds print the code on screen, so no handset is needed.
  const code = dump().match(/Demo code[^0-9]*(\d{6})/i)?.[1];
  if (!code) throw new Error("the demo code was not on screen — are dev tools enabled?");
  console.log(`  signing in with demo code ${code}`);
  await tap("verification code", { label: "the code field" });
  adb(["shell", "input", "text", code]);
  await sleep(600);
  await tap("verify and continue");
  await waitFor("find a voucher hunt", 40000);
  console.log("  signed in");

  // --- Tabs --------------------------------------------------------------
  // Opening the app is itself what awards the daily points, so More is worth
  // visiting after a moment rather than first.
  for (const [tab, name, anchor] of [
    ["Quests", "customer-07-quests", "quests"],
    ["LP Shop", "customer-08-shop", "spend your lp"],
    ["More", "customer-06-more", "loyalty points"],
  ]) {
    await tap(tab, { label: `the ${tab} tab` });
    await waitFor(anchor, 25000);
    await sleep(1500);
    screenshot(name);
  }

  console.log("\n4 captured");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
