import { isSelectableAttempt, type VoucherAttempt } from "@bizflow/shared";

// Relative rather than aliased: this module is covered by the root test suite,
// which resolves the repo without the app's "@/" paths.
import { attemptToReveal } from "./progress";

/**
 * What the reel should do when it opens.
 *
 * This is the one place an attempt can be spent, so it is a pure function with
 * tests rather than a chain of conditions inside an effect. The history behind
 * that: the reel used to draw as a side effect of mounting, and the navigator
 * mounts it far more often than a customer asks for a spin — a stale reel left
 * in the campaign stack remounts when the screens above it unwind, a hot reload
 * remounts it, and swapping campaigns hands the mounted screen a new slug. Each
 * of those quietly bought a voucher. A customer who tapped "Let's Hunt!" once
 * could land on a results list holding three prizes they never saw drawn, with
 * all three of the campaign's attempts spent.
 *
 * So a draw now needs someone to have asked for it. `hasIntent` is that ask,
 * granted by the campaign landing (or the "Spin again" button) as it navigates
 * here and consumed exactly once — a mount that arrives without one is the
 * navigator's doing, not the customer's, and must never cost an attempt.
 */
export type ReelAction =
  /** Reveal a draw already held: the customer paid for it and never saw it. */
  | { type: "reveal"; attempt: VoucherAttempt }
  /** Spend an attempt. Only ever returned when the customer asked for one. */
  | { type: "draw" }
  /** This campaign is finished; its voucher is the thing to show. */
  | { type: "voucher" }
  /** Nothing to reveal and nobody asked to spin: go back to the landing. */
  | { type: "leave" };

export function reelAction(input: {
  attempts: VoucherAttempt[];
  /** True when the customer asked for a spin on the way in. */
  hasIntent: boolean;
  /** True once this campaign's final voucher has been issued. */
  hasVoucher: boolean;
  /** "Spin again": a deliberate request for a new draw, not a resume. */
  freshSpin: boolean;
}): ReelAction {
  // A campaign allows one final voucher. Drawing again is refused server-side
  // as E-DUPLICATE-FINAL, so there is nothing to spin for.
  if (input.hasVoucher) return { type: "voucher" };

  const held = attemptToReveal(input.attempts);

  // A draw that was made but never landed. It is theirs and already paid for,
  // so any arrival here reveals it rather than buying another — including one
  // with no intent, which is how an interrupted spin resumes.
  //
  // "Spin again" is the exception: it is a request for a *new* draw, and would
  // otherwise re-show the prize they just declined to book.
  if (held && !input.freshSpin) return { type: "reveal", attempt: held };

  // Everything past here spends an attempt, so it needs the customer's ask.
  if (!input.hasIntent) {
    // A held draw with no intent still beats leaving: "Spin again" that lost
    // its intent to a remount should show the prize, not abandon the screen.
    return held ? { type: "reveal", attempt: held } : { type: "leave" };
  }

  return { type: "draw" };
}

/**
 * Whether a campaign is holding anything a resume could return to.
 *
 * Shared by the landing's "Continue" label and by the reel, so the button and
 * the screen it opens can never disagree about whether a hunt is under way.
 */
export function hasLiveAttempt(attempts: VoucherAttempt[]): boolean {
  return attempts.some(isSelectableAttempt);
}
