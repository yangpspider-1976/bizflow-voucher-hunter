import { AppError } from "@/server/errors";

/**
 * Shared secret for scheduled invocations.
 *
 * `CRON_SECRET` is what Vercel Cron sends as a bearer token, so a job declared
 * in `vercel.json` authenticates with no extra configuration. `?secret=` is
 * accepted too, for schedulers that cannot set a header.
 *
 * Unset means refuse, never "allow": a deploy that forgot the variable would
 * otherwise expose a publicly invocable fan-out that sends real SMS and push.
 */
export function assertCronAuth(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    throw new AppError("E-CRON-UNCONFIGURED", "CRON_SECRET is not configured", 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  const query = new URL(request.url).searchParams.get("secret")?.trim() ?? "";
  if (bearer !== expected && query !== expected) {
    throw new AppError("E-CRON-AUTH", "Invalid cron secret", 401);
  }
}
