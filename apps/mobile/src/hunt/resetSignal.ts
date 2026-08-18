/**
 * Synchronizes a development reset across the More tab and any campaign stack
 * Expo Router is keeping mounted in the background.
 *
 * Carries no slug because a reset clears every campaign the phone has hunted:
 * a background stack that kept its local state because the signal named a
 * different campaign would go on to reconfirm an attempt the server deleted.
 *
 * It has two phases because its listeners need opposite timing, and collapsing
 * them into one broadcast is what made a failed reset destructive:
 *
 *  - `starting` fires before the request. A roulette kept mounted behind the
 *    More tab has to stop drawing *first*, or its in-flight request lands after
 *    the delete and recreates the attempt the reset just removed.
 *  - `completed` fires only once the server has actually cleared the rows, and
 *    is what drops local continuation state. Announcing that up front left the
 *    app insisting the hunt was gone while the server still held it, so the
 *    campaign CTA offered to continue a hunt that no longer matched anything —
 *    and a reset that failed (offline, 404, a 500) silently produced exactly
 *    that state with no way back short of restarting the app.
 */
type HuntResetPhase = "starting" | "completed";
type HuntResetListener = () => void;

const listeners: Record<HuntResetPhase, Set<HuntResetListener>> = {
  starting: new Set(),
  completed: new Set(),
};

function publish(phase: HuntResetPhase) {
  for (const listener of listeners[phase]) listener();
}

function subscribe(phase: HuntResetPhase, listener: HuntResetListener) {
  listeners[phase].add(listener);
  return () => {
    listeners[phase].delete(listener);
  };
}

/** Stop anything that could still write to the hunt. Call before the request. */
export function publishHuntResetStarting() {
  publish("starting");
}

export function subscribeToHuntResetStarting(listener: HuntResetListener) {
  return subscribe("starting", listener);
}

/** The server has cleared the rows. Call only after the request succeeds. */
export function publishHuntResetCompleted() {
  publish("completed");
}

export function subscribeToHuntResetCompleted(listener: HuntResetListener) {
  return subscribe("completed", listener);
}
