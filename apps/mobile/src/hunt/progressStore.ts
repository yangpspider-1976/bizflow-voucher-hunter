import * as SecureStore from "expo-secure-store";

import {
  parseProgressMap,
  pruneProgress,
  type HuntProgress,
  type HuntProgressMap,
} from "@/hunt/progress";

const PROGRESS_KEY = "voucher_hunt_progress";

/**
 * Persists the campaign resume points, following `devTools`' pool choices: one
 * JSON blob keyed by slug, because SecureStore holds strings and cannot list
 * its own keys — and clearing every campaign at once is exactly what a hunt
 * reset needs to do.
 *
 * Every function here swallows storage failures. Progress is a convenience laid
 * over authoritative server state, so a device that cannot read or write it
 * should fall back to starting from the snapshot, not fail to open a campaign.
 */
async function readAll(): Promise<HuntProgressMap> {
  try {
    return parseProgressMap(await SecureStore.getItemAsync(PROGRESS_KEY));
  } catch {
    return {};
  }
}

export async function readHuntProgress(
  slug: string,
): Promise<HuntProgress | null> {
  return (await readAll())[slug] ?? null;
}

export async function writeHuntProgress(
  slug: string,
  progress: Omit<HuntProgress, "updatedAt">,
): Promise<void> {
  try {
    const entries = await readAll();
    entries[slug] = { ...progress, updatedAt: Date.now() };
    await SecureStore.setItemAsync(
      PROGRESS_KEY,
      JSON.stringify(pruneProgress(entries)),
    );
  } catch {
    // Losing the resume point costs a step, not the hunt.
  }
}

/** Every campaign's resume point, dropped together with a hunt reset. */
export async function clearHuntProgress(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PROGRESS_KEY);
  } catch {
    // Same reasoning as above; the server state is what a reset actually clears.
  }
}
