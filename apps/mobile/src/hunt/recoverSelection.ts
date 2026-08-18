import { isSelectableAttempt, type VoucherAttempt } from "@bizflow/shared";

/**
 * What to do when `GET /hunt/slots` rejects the attempt the app is holding.
 *
 * The slot picker used to collapse all of these into "your selection expired",
 * which was wrong twice over: it declared a lost candidate on evidence that did
 * not support it, and it left the customer on a screen telling them to start a
 * new hunt with no control that would.
 */
export type SelectionRecovery =
  /** No authoritative answer yet — safe to load again, nothing is lost. */
  | { kind: "retry" }
  /** A final voucher already exists; the picker is the wrong screen entirely. */
  | { kind: "voucher" }
  /** A usable candidate is still on the server — book against this one. */
  | { kind: "attempt"; attempt: VoucherAttempt }
  /** The server has spoken and holds nothing bookable. Only now is it gone. */
  | { kind: "expired" };

/**
 * Decides between those cases from the campaign snapshot.
 *
 * `snapshot` is null when the client could not ask — the visitor session is
 * still hydrating, say. That is the distinction the screen was missing: not
 * being able to ask is not the same answer as being told there is nothing left,
 * and only the latter should cost someone the candidate they already spent an
 * attempt on.
 *
 * The current selection wins if the server still lists it, whatever its status,
 * because the caller has already established the id is real; otherwise the most
 * recent selectable attempt stands in, matching how the reel hands off to the
 * picker after a fresh draw.
 */
export function recoverSelection({
  selectedAttemptId,
  snapshot,
}: {
  selectedAttemptId: string;
  snapshot: { attempts: VoucherAttempt[]; voucher?: unknown } | null;
}): SelectionRecovery {
  if (!snapshot) return { kind: "retry" };
  if (snapshot.voucher) return { kind: "voucher" };

  const attempt =
    snapshot.attempts.find((candidate) => candidate.id === selectedAttemptId) ??
    snapshot.attempts.slice().reverse().find(isSelectableAttempt);

  return attempt ? { kind: "attempt", attempt } : { kind: "expired" };
}
