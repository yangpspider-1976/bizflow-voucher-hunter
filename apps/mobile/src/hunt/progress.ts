import { isSelectableAttempt, type VoucherAttempt } from "@bizflow/shared";

/**
 * Where a customer had got to in a campaign, so an interrupted hunt can be
 * picked up rather than restarted.
 *
 * The server knows what was *drawn* and what was *issued*, but nothing between:
 * a candidate that has been revealed on the reel and one that has not are the
 * same row, and a slot is only written when the voucher is finally claimed. So
 * the step itself is client state — and it has to outlive the process, because
 * "interrupted" usually means the app was swapped away and dropped.
 *
 * Only ids and the step are kept. The customer's name and email are deliberately
 * not: they come back from `GET /hunt/state` when they matter, and a half-typed
 * booking form is not worth another copy of someone's details on disk.
 */
export type HuntStep =
  /** The reel is owed a reveal — a draw was made but never landed. */
  | "roulette"
  | "results"
  | "datetime"
  | "confirm"
  | "confirmation";

export type HuntProgress = {
  step: HuntStep;
  /** The candidate being booked. Empty while the reel still owes a reveal. */
  attemptId?: string;
  slotId?: string;
  date?: string;
  guestCount?: string;
  /** Millisecond stamp; only used to decide which campaigns to keep. */
  updatedAt: number;
};

export type HuntProgressMap = Record<string, HuntProgress>;

/**
 * How many campaigns keep a resume point.
 *
 * The whole map is one SecureStore value, and the platform can reject a large
 * payload outright — historically anything past roughly 2KB. A customer hunts
 * one campaign at a time, so a handful is generous; the oldest are dropped
 * rather than risking a write that fails and takes the campaign they are
 * actually in the middle of with it.
 */
export const MAX_TRACKED_CAMPAIGNS = 8;

const STEPS: HuntStep[] = [
  "roulette",
  "results",
  "datetime",
  "confirm",
  "confirmation",
];

function isStep(value: unknown): value is HuntStep {
  return typeof value === "string" && STEPS.includes(value as HuntStep);
}

/**
 * The step a campaign path represents, or null for anything that is not one of
 * this campaign's hunt screens.
 *
 * The landing page is deliberately null rather than a step of its own: it is
 * where a resume is *offered*, so recording it would erase the progress the
 * customer went there to continue. Paths belonging to another campaign — the
 * navigator keeps a stack mounted in the background — are null for the same
 * reason, one campaign's screens must never write another's progress.
 */
export function stepFromPathname(pathname: string, slug: string): HuntStep | null {
  const [, root, pathSlug, step] = pathname.split("/");
  if (root !== "campaign" || !pathSlug) return null;

  let decoded = pathSlug;
  try {
    decoded = decodeURIComponent(pathSlug);
  } catch {
    // A malformed escape is not this campaign's slug either way.
  }
  if (decoded !== slug) return null;

  return isStep(step) ? step : null;
}

/** Tolerant read: a corrupt or half-written blob is no progress, never a throw. */
export function parseProgressMap(raw: string | null): HuntProgressMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const entries: HuntProgressMap = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (!isStep(record.step)) continue;
    entries[slug] = {
      step: record.step,
      ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
      ...(typeof record.slotId === "string" ? { slotId: record.slotId } : {}),
      ...(typeof record.date === "string" ? { date: record.date } : {}),
      ...(typeof record.guestCount === "string"
        ? { guestCount: record.guestCount }
        : {}),
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  }
  return entries;
}

/** Keeps the most recently touched campaigns, newest first. */
export function pruneProgress(
  entries: HuntProgressMap,
  limit = MAX_TRACKED_CAMPAIGNS,
): HuntProgressMap {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit)),
  );
}

/**
 * The draw a resumed reel owes the customer: the newest one still bookable.
 *
 * Matches how a fresh spin hands off to the picker — the last thing drawn is
 * the one being worked on — so a resume lands on the same candidate the rest of
 * the flow would have selected anyway.
 */
export function attemptToReveal(
  attempts: VoucherAttempt[],
): VoucherAttempt | undefined {
  return attempts.slice().reverse().find(isSelectableAttempt);
}

/**
 * The screen a "Continue" should land on.
 *
 * Server truth outranks the remembered step in both directions, because the
 * step alone can describe a hunt that no longer exists: a voucher issued on
 * another device outranks everything, and a remembered booking screen is worth
 * nothing once the candidate behind it has expired. What the step adds is the
 * distinction the server cannot make — whether the reel already handed its
 * result over, or still owes the customer the reveal they paid an attempt for.
 */
export function resumeStep(input: {
  attempts: VoucherAttempt[];
  hasVoucher: boolean;
  selectedAttemptId: string;
  selectedSlotId: string;
  step: HuntStep | null;
}): HuntStep {
  if (input.hasVoucher) return "confirmation";

  const selectable = input.attempts.filter(isSelectableAttempt);
  if (selectable.length === 0) {
    // A remembered booking stands until something contradicts it. With no
    // attempts to judge by — an offline resume, where the snapshot never
    // arrived — sending someone who has already booked to the reel would ask
    // them to hunt a campaign they have finished.
    if (input.step === "confirmation") return "confirmation";
    // Otherwise nothing bookable is being held, so there is nothing to return
    // to: whatever screen they left, the next thing to happen is a draw.
    return "roulette";
  }

  const selected = selectable.some(
    (attempt) => attempt.id === input.selectedAttemptId,
  );

  switch (input.step) {
    // A draw the reel never landed. Sending them to the results list instead
    // would show the prize as a fait accompli and quietly skip the reveal.
    case "roulette":
      return "roulette";
    case "confirm":
      if (!selected) return "results";
      return input.selectedSlotId ? "confirm" : "datetime";
    case "datetime":
      return selected ? "datetime" : "results";
    // "confirmation" with no voucher means the issued one is gone — a reset, or
    // a campaign that has been rebuilt underneath them. The candidates that
    // remain are still bookable, so the results list is the honest step.
    default:
      return "results";
  }
}
