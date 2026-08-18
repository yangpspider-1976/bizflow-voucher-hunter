import { describe, expect, it } from "vitest";

import {
  publishHuntResetCompleted,
  publishHuntResetStarting,
  subscribeToHuntResetCompleted,
  subscribeToHuntResetStarting,
} from "../../apps/mobile/src/hunt/resetSignal";

/**
 * The two phases exist because a single broadcast made a failed reset
 * destructive: the roulette has to stop drawing before the request, but nothing
 * may drop local state until the server has actually cleared it.
 */
describe("hunt reset signal", () => {
  it("keeps the phases separate", () => {
    const seen: string[] = [];
    const offStart = subscribeToHuntResetStarting(() => seen.push("starting"));
    const offDone = subscribeToHuntResetCompleted(() => seen.push("completed"));

    publishHuntResetStarting();
    expect(seen).toEqual(["starting"]);

    publishHuntResetCompleted();
    expect(seen).toEqual(["starting", "completed"]);

    offStart();
    offDone();
  });

  it("does not announce completion when only the request has begun", () => {
    // The regression: a reset that failed after `starting` used to leave every
    // campaign screen believing its hunt was cleared while the server still
    // held it, so the campaign CTA offered to continue a hunt that no longer
    // matched anything.
    let cleared = 0;
    const off = subscribeToHuntResetCompleted(() => {
      cleared += 1;
    });

    publishHuntResetStarting();
    expect(cleared).toBe(0);

    off();
  });

  it("stops delivering once unsubscribed", () => {
    let starting = 0;
    let completed = 0;
    const offStart = subscribeToHuntResetStarting(() => {
      starting += 1;
    });
    const offDone = subscribeToHuntResetCompleted(() => {
      completed += 1;
    });

    offStart();
    offDone();
    publishHuntResetStarting();
    publishHuntResetCompleted();

    expect(starting).toBe(0);
    expect(completed).toBe(0);
  });

  it("notifies every mounted listener of a phase", () => {
    // A campaign stack Expo Router keeps mounted in the background subscribes
    // alongside the foreground one; both have to hear it.
    let calls = 0;
    const offs = [0, 1, 2].map(() =>
      subscribeToHuntResetCompleted(() => {
        calls += 1;
      }),
    );

    publishHuntResetCompleted();
    expect(calls).toBe(3);

    for (const off of offs) off();
  });
});
