import crypto from "node:crypto";

/**
 * Where production failures go.
 *
 * Before this there was nowhere: an API route that threw returned its 500 and
 * the stack died with the invocation. The only monitoring in the system was a
 * customer deciding to complain.
 *
 * Two sinks, and the first is not optional:
 *
 *   **stdout, always.** One JSON object per line, which is what Vercel's log
 *   drains, `vercel logs`, and every log shipper worth using expect. This works
 *   with no configuration and no third party, and it is what you search after
 *   the fact.
 *
 *   **A webhook, when `ERROR_WEBHOOK_URL` is set.** This is the half that wakes
 *   someone up. Any Slack or Discord incoming webhook works as-is — the payload
 *   carries both services' field names, so neither needs a bespoke integration.
 *
 * Deliberately not Sentry. Everything funnels through `reportError`, so adopting
 * a real APM later is one function body, not a sweep of the codebase — but the
 * gap worth closing today is "nobody finds out", and that does not need an
 * account, an SDK, or thirteen more dependencies in a release week.
 */

export type Severity = "error" | "warning";

export type ReportContext = {
  /** Where it happened: a route path, a job name, a module function. */
  source: string;
  /** Anything that helps diagnosis. Must not contain personal data — see below. */
  detail?: Record<string, unknown>;
};

/**
 * Alerts are not a place to put customer data.
 *
 * A webhook lands in a chat room with a different membership from the database,
 * and it is retained by whoever hosts it. Phone numbers, names, emails and
 * tokens are dropped rather than forwarded, however useful they would be: the
 * ids that remain are enough to find the row.
 */
const FORBIDDEN_KEYS = /phone|name|email|token|secret|code|password|authorization/i;

function scrub(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      FORBIDDEN_KEYS.test(key) ? "[redacted]" : value,
    ]),
  );
}

/**
 * How often one distinct problem may alert.
 *
 * A failing dependency does not fail once; it fails on every request until it is
 * fixed. Unthrottled, the first outage empties the webhook's rate limit and the
 * *next* alert — possibly a different and worse one — is the one that gets
 * dropped. The log line is always written, so nothing is lost by staying quiet
 * in chat.
 *
 * Per-instance, because serverless has no shared memory to put it in. A cold
 * fleet may send a handful of copies; a hot loop cannot send thousands.
 */
const ALERT_INTERVAL_MS = 5 * 60_000;
const recentAlerts = new Map<string, number>();

/** Slowest an alert may make a request that is already failing. */
const WEBHOOK_TIMEOUT_MS = 1500;

function fingerprint(source: string, message: string) {
  // Digits are stripped so that "voucher vch_ab12 not found" and the next id
  // over count as the same problem rather than a fresh one every request.
  const normalized = `${source}:${message}`.replace(/[0-9a-f]{6,}|\d+/gi, "*");
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function shouldAlert(key: string) {
  const now = Date.now();
  const last = recentAlerts.get(key);
  if (last !== undefined && now - last < ALERT_INTERVAL_MS) return false;
  recentAlerts.set(key, now);
  // The map only ever holds distinct live problems; if it grows past anything
  // sane, the throttle is not the thing that needs fixing.
  if (recentAlerts.size > 200) recentAlerts.clear();
  return true;
}

async function notify(text: string) {
  const url = process.env.ERROR_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` is Slack's field, `content` is Discord's. Each ignores the other.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    // An alerting failure must never become the failure. The log line above it
    // has already been written, which is the part that has to be reliable.
  }
}

const environment = () =>
  process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";

/**
 * Records something that went wrong and, when it is worth interrupting someone
 * over, says so out loud.
 *
 * Never throws and never rejects: every caller is already on a failure path.
 */
export async function reportError(error: unknown, context: ReportContext) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const key = fingerprint(context.source, message);
  const detail = context.detail ? scrub(context.detail) : undefined;

  console.error(
    JSON.stringify({
      level: "error",
      event: "app_error",
      fingerprint: key,
      source: context.source,
      message,
      env: environment(),
      detail,
      stack,
      at: new Date().toISOString(),
    }),
  );

  if (!shouldAlert(key)) return;
  await notify(
    `🔴 *${environment()}* error in \`${context.source}\`\n${message}\n_fingerprint ${key}_`,
  );
}

/**
 * Records a condition that is not an exception but still wants a human — a
 * reconciliation that does not balance, an audit chain that does not verify.
 *
 * These are the alerts most worth having, because nothing crashed: the system is
 * behaving perfectly while being wrong.
 */
export async function reportAlert(input: {
  title: string;
  message: string;
  severity?: Severity;
  source: string;
  detail?: Record<string, unknown>;
}) {
  const severity = input.severity ?? "warning";
  const key = fingerprint(input.source, input.title);

  console.error(
    JSON.stringify({
      level: severity,
      event: "app_alert",
      fingerprint: key,
      source: input.source,
      title: input.title,
      message: input.message,
      env: environment(),
      detail: input.detail ? scrub(input.detail) : undefined,
      at: new Date().toISOString(),
    }),
  );

  if (!shouldAlert(key)) return;
  const icon = severity === "error" ? "🔴" : "🟠";
  await notify(`${icon} *${environment()}* — ${input.title}\n${input.message}`);
}
