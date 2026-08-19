import { useRouter } from "expo-router";
import { useCallback } from "react";

/**
 * Returns to a campaign's landing, collapsing everything the hunt pushed on top
 * of it.
 *
 * Every hunt step used to get back with `replace`, which swaps one screen and
 * leaves the rest of the stack standing: a customer moving between the landing
 * and the reel built up `[landing, reel, landing, reel, …]`, and because Expo
 * Router keeps one stack for every campaign and only swaps the slug, all of it
 * was still there on the next campaign they opened. That is what put a stale
 * reel in front of a campaign page nobody had opened it for, and unwinding it a
 * screen at a time remounted each stale reel on the way past.
 *
 * `dismissTo` collapses the lot in one action, and names the landing explicitly
 * so a campaign switch cannot land on the previous campaign's page.
 */
export function useReturnToLanding(slug: string) {
  const router = useRouter();
  return useCallback(() => {
    const landing = { pathname: "/campaign/[slug]" as const, params: { slug } };
    // dismissTo falls back to a replace when the landing is not in the stack,
    // but it can only be asked that question by a stack that has something to
    // dismiss in the first place.
    if (router.canDismiss()) router.dismissTo(landing);
    else router.replace(landing);
  }, [router, slug]);
}
