import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { AchievementUnlockNotice, GamificationProfile } from "@bizflow/shared";

import { acknowledgeUnlocks, getGamificationProfile } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/**
 * One copy of the player's level, missions and achievements for the whole app.
 *
 * Held here rather than fetched per screen because four screens show slices of
 * the same state and would otherwise disagree — the home card saying level 2
 * while the quests tab, loaded a moment earlier, still says level 1. Everything
 * displayed comes from the server; nothing in this file works out a level, a
 * reward or a completion on its own.
 */
type GamificationContextValue = {
  profile: GamificationProfile | null;
  isLoading: boolean;
  error: unknown;
  /** Re-reads the profile. Also creates today's missions, server-side. */
  refresh: () => Promise<void>;
  /** The unlock currently being celebrated, if any. */
  celebrating: AchievementUnlockNotice | null;
  /** Dismisses the current celebration and tells the server it was shown. */
  dismissCelebration: () => void;
  /**
   * A promotion the player has not been shown yet, or null. Separate from the
   * badge queue because it is a different screen, and because a single session
   * can genuinely owe both.
   */
  levelUpToAnnounce: number | null;
  dismissLevelUp: () => void;
};

const GamificationContext = createContext<GamificationContextValue | null>(null);

export function GamificationProvider({ children }: PropsWithChildren) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<GamificationProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [queue, setQueue] = useState<AchievementUnlockNotice[]>([]);
  const [levelUp, setLevelUp] = useState<number | null>(null);
  // Screens refresh on focus, so tab-hopping would otherwise stack overlapping
  // reads and let a slower one land last with older data.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!token) {
      setProfile(null);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const next = await getGamificationProfile(token);
      setProfile(next);
      // The server decides what is unseen, so a badge unlocked on another
      // device is still celebrated here, and one already celebrated is not
      // celebrated twice.
      setQueue(next.unseenUnlocks);
      setLevelUp(next.levelUpToAnnounce);
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A mission can complete while the app is backgrounded — an ad callback lands,
  // staff scan a QR at the till — so returning to the app re-reads rather than
  // showing whatever was true when it was last open.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const dismissLevelUp = useCallback(() => {
    setLevelUp(null);
    if (token) void acknowledgeUnlocks({ levelUp: true }, token).catch(() => undefined);
  }, [token]);

  const dismissCelebration = useCallback(() => {
    setQueue((current) => {
      const [shown, ...rest] = current;
      if (shown && token) {
        // Fire and forget: a failed acknowledgement means the celebration is
        // offered again next launch, which is far better than losing it.
        void acknowledgeUnlocks({ groupKeys: [shown.groupKey] }, token).catch(() => undefined);
      }
      return rest;
    });
  }, [token]);

  const value = useMemo(
    () => ({
      profile,
      isLoading,
      error,
      refresh,
      celebrating: queue[0] ?? null,
      dismissCelebration,
      levelUpToAnnounce: levelUp,
      dismissLevelUp,
    }),
    [profile, isLoading, error, refresh, queue, dismissCelebration, levelUp, dismissLevelUp],
  );

  return (
    <GamificationContext.Provider value={value}>{children}</GamificationContext.Provider>
  );
}

/**
 * Re-reads the profile whenever a screen showing it comes into view.
 *
 * The provider alone is not enough: it loads once and then only on
 * app-foreground, so a screen reached by navigation renders whatever was true
 * when the app opened. That is wrong the moment anything else moves a balance -
 * points earned at a till, an item bought in the LP shop, a transfer between
 * pots - and the Level Up screen in particular decides what a customer is
 * allowed to convert, so a stale number there is not cosmetic.
 *
 * Guarded against overlap in `refresh`, so switching tabs quickly costs one
 * request rather than a pile of them.
 */
export function useGamificationFocusRefresh() {
  const { refresh } = useGamification();
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
}

export function useGamification() {
  const context = useContext(GamificationContext);
  if (!context) {
    throw new Error("useGamification must be used inside a GamificationProvider");
  }
  return context;
}
