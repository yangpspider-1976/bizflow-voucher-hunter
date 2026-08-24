import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { reportError } from "@/server/monitoring";
import type { ErrorResponse, SuccessResponse } from "@/types/voucher";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  const payload: SuccessResponse<T> = { success: true, data };
  return NextResponse.json(payload, init);
}

/**
 * Async so the alert is actually sent.
 *
 * A serverless invocation may be frozen the moment its response resolves, which
 * makes a fire-and-forget webhook a coin toss — and the toss is lost precisely
 * during an incident, when the process is being recycled fastest. Awaiting costs
 * at most `WEBHOOK_TIMEOUT_MS`, only on a 5xx, and only for the first occurrence
 * inside the throttle window. Every `fail()` call site already sits in an async
 * handler and returns it directly, so nothing else changes.
 */
export async function fail(error: unknown) {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError("E-VALIDATION-400", "Invalid request input", 400, error.flatten())
      : new AppError("E-SYSTEM-500", "Unexpected server error", 500);

  // Every route ends here, which makes this the one place that sees a failure
  // before it becomes a response body.
  //
  // Only 5xx is reported. A 4xx is the API working: a sold-out slot, a wrong
  // OTP, a malformed payload. Alerting on those would bury the one class of
  // error nobody is expecting — and the 500 branch above is precisely the case
  // where the message has been replaced by "Unexpected server error", so the
  // original is lost unless it is captured here.
  if (appError.status >= 500) {
    await reportError(error, {
      source: "api",
      detail: { code: appError.code },
    });
  }

  const payload: ErrorResponse = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details
    }
  };
  return NextResponse.json(payload, { status: appError.status });
}
