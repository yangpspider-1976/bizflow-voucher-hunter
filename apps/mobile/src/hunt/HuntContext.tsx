import {
  isSelectableAttempt,
  type CampaignSlot,
  type Voucher,
  type VoucherAttempt,
} from "@bizflow/shared";
import { usePathname, useRouter } from "expo-router";
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

import {
  getCampaign,
  getHuntState,
  startHunt,
  type HuntState,
  type PublicCampaign,
  type PublicSlot,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import {
  mergeAttempts,
  reconcileSnapshotAttempts,
  PENDING_ATTEMPT_GRACE_MS,
} from "@/hunt/reconcileAttempts";
import {
  isHuntStepPath,
  stepFromPathname,
  type HuntProgress,
  type HuntStep,
} from "@/hunt/progress";
import {
  clearCampaignProgress,
  clearHuntProgress,
  readHuntProgress,
  writeHuntProgress,
} from "@/hunt/progressStore";
import { subscribeToHuntResetCompleted } from "@/hunt/resetSignal";
import { getVisitorSessionId } from "@/hunt/session";


export type IssuedPayload = { voucher: Voucher; slot: CampaignSlot };

/**
 * Mirrors the web's `FlowState`, minus everything that only existed to survive a
 * page reload. The web persists this to `localStorage` because each step is a
 * separate document; here the steps share one navigator, and a cold start re-reads
 * the authoritative snapshot from `GET /hunt/state`.
 *
 * `step` and the selection ids are the exception: no snapshot can say which
 * screen the customer was on, so those are mirrored to storage — see
 * `hunt/progress`.
 */
type FlowState = {
  userId: string;
  attempts: VoucherAttempt[];
  selectedAttemptId: string;
  selectedSlotId: string;
  selectedDate: string;
  name: string;
  email: string;
  guestCount: string;
  issued: IssuedPayload | null;
  bonusAttempts: number;
  shareCount: number;
  /** The hunt screen last visited, restored on a cold start. */
  step: HuntStep | null;
};

const emptyFlow: FlowState = {
  userId: "",
  attempts: [],
  selectedAttemptId: "",
  selectedSlotId: "",
  selectedDate: "",
  name: "",
  email: "",
  guestCount: "2",
  issued: null,
  bonusAttempts: 0,
  shareCount: 0,
  step: null,
};

type HuntContextValue = {
  slug: string;
  /** Campaign + business + all slots, from `GET /campaigns/[slug]`. */
  campaign: PublicCampaign | null;
  loading: boolean;
  /** Raw thrown error, so screens can tell offline apart from a server failure. */
  error: unknown;
  /** Re-runs the campaign + snapshot fetch, for a retry affordance. */
  reload: () => void;
  sessionId: string;
  flow: FlowState;
  save: (next: Partial<FlowState>) => void;
  /** Adds a freshly drawn attempt and selects it, keeping earlier spins intact. */
  addAttempt: (attempt: VoucherAttempt) => void;
  /** Registers this phone against the campaign and pulls the hunt snapshot. */
  /**
   * Starts or resumes this campaign and returns the server snapshot used to
   * decide the next screen. Returning it avoids navigating with stale React
   * state while a newly selected campaign is still being hydrated.
   */
  begin: () => Promise<HuntState | null>;
  refreshSnapshot: () => Promise<HuntState | null>;
  /** Records the voucher this app has just issued, and holds it against lag. */
  settleVoucher: (issued: IssuedPayload) => void;
  /** Called by the landing before it navigates into a step of this campaign. */
  markHuntEntered: () => void;
  /**
   * Whether a step of *this* campaign was entered from its landing.
   *
   * A ref rather than state, and read rather than rendered: the screens ask in
   * an effect that runs before this provider's own effects, so the answer has to
   * be correct synchronously.
   */
  huntWasEntered: () => boolean;
  selectedAttempt: VoucherAttempt | undefined;
  slotById: (id: string) => PublicSlot | undefined;
};

const HuntContext = createContext<HuntContextValue | null>(null);

function preferredAttemptId(
  attempts: VoucherAttempt[],
  currentId = "",
): string {
  const current = attempts.find((attempt) => attempt.id === currentId);
  if (current && isSelectableAttempt(current)) return current.id;
  return attempts.slice().reverse().find(isSelectableAttempt)?.id ?? "";
}

/** The stored resume point, as the slice of flow state it stands for. */
function flowFromProgress(progress: HuntProgress | null): Partial<FlowState> {
  if (!progress) return {};
  return {
    step: progress.step,
    selectedAttemptId: progress.attemptId ?? "",
    selectedSlotId: progress.slotId ?? "",
    selectedDate: progress.date ?? "",
    guestCount: progress.guestCount || emptyFlow.guestCount,
  };
}

/**
 * The issued voucher together with the slot it was booked at.
 *
 * The slot comes from the snapshot itself wherever possible. Deriving it only
 * from the campaign's slot list is what could make a confirmed booking
 * unresumable: if that one lookup missed, the app dropped the voucher it had
 * just been told about, and the landing offered a fresh hunt the server then
 * refused as a duplicate. A voucher the client already knows about is never
 * given up over a failed lookup — only the server saying there is none clears it.
 */
function issuedFrom({
  campaign,
  current,
  now,
  pendingIssue,
  state,
}: {
  campaign: PublicCampaign | null;
  current: IssuedPayload | null;
  now: number;
  pendingIssue: { voucherId: string; at: number } | null;
  state: Pick<HuntState, "voucher" | "voucherSlot">;
}): IssuedPayload | null {
  const { voucher } = state;
  if (voucher) {
    const slot =
      state.voucherSlot ??
      campaign?.slots.find((candidate) => candidate.id === voucher.slotId) ??
      (current?.voucher.id === voucher.id ? current.slot : undefined);
    return slot ? { voucher, slot } : current;
  }

  // The server reports no voucher. That is authoritative unless this app is the
  // one that just issued it: the same replica lag `pendingAttempts` guards
  // against applies here with more at stake, since dropping the booking a
  // customer is looking at also offers them a hunt the server will refuse.
  const justIssued =
    current !== null &&
    pendingIssue?.voucherId === current.voucher.id &&
    now - pendingIssue.at < PENDING_ATTEMPT_GRACE_MS;
  return justIssued ? current : null;
}

export function HuntProvider({ children, slug }: PropsWithChildren<{ slug: string }>) {
  const { token } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [campaign, setCampaign] = useState<PublicCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Bumped to re-run the load effect without duplicating its body.
  const [reloadToken, setReloadToken] = useState(0);
  const [sessionId, setSessionId] = useState("");
  const [flow, setFlow] = useState<FlowState>(emptyFlow);
  // Gates the progress writer: until the stored resume point has been read back,
  // this campaign's flow is empty by default rather than by choice, and saving
  // it would overwrite the progress still being loaded.
  const [hydrated, setHydrated] = useState(false);
  // Draw responses are authoritative writes, but a snapshot read routed through
  // another production replica can briefly lag behind them. Track those locally
  // acknowledged attempts until a snapshot sees them or the grace window ends.
  const pendingAttempts = useRef(new Map<string, number>());
  // The voucher this app issued itself, for the same reason and the same window.
  const pendingIssue = useRef<{ voucherId: string; at: number } | null>(null);
  // False for a freshly mounted campaign, which is the whole point: the
  // navigator keeps one stack for every campaign, so a step screen can find
  // itself rendering a campaign nobody opened it for.
  const entered = useRef(false);
  // Read by callbacks that must not re-create themselves on every flow change.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  /**
   * Folds a server snapshot into the flow, keeping the local progress it does
   * not contradict.
   *
   * A selection the server still lists keeps its slot; one it no longer holds
   * takes its slot with it, because a time picked against a candidate that is
   * gone must not be carried into a booking for a different one.
   */
  const applySnapshot = useCallback(
    (state: HuntState, publicCampaign: PublicCampaign | null) => {
      const now = Date.now();
      const pending = pendingIssue.current;
      setFlow((current) => {
        const attempts = reconcileSnapshotAttempts({
          current: current.attempts,
          incoming: state.attempts,
          pending: pendingAttempts.current,
        });
        const selectedAttemptId = preferredAttemptId(
          attempts,
          current.selectedAttemptId,
        );
        const keptSelection =
          Boolean(current.selectedAttemptId) &&
          selectedAttemptId === current.selectedAttemptId;
        const issued = issuedFrom({
          campaign: publicCampaign,
          current: current.issued,
          now,
          pendingIssue: pending,
          state,
        });
        // A hunt this phone started is remembered locally so a failed refresh
        // cannot un-start it — but a refresh that *succeeds* and reports no
        // attempts and no voucher is the server saying the hunt is gone, which
        // is what a reset looks like from here. Without this the campaign would
        // go on offering Continue for a hunt that no longer exists.
        const emptied = attempts.length === 0 && issued === null;
        if (emptied) void clearCampaignProgress(slug);

        return {
          ...current,
          userId: state.user.id,
          attempts,
          selectedAttemptId,
          step: emptied ? null : current.step,
          selectedSlotId: keptSelection ? current.selectedSlotId : "",
          selectedDate: keptSelection ? current.selectedDate : "",
          bonusAttempts: state.remainingBonusAttempts,
          shareCount: state.sharesGrantedToday,
          name: current.name || state.user.name || "",
          email: current.email || state.user.email || "",
          issued,
        };
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;

    async function load() {
      if (!token) return;
      setLoading(true);
      setError(null);
      // Belt and braces alongside the provider's `key`: whatever is in state
      // describes the previous campaign, and showing any of it against a new slug
      // is wrong — an issued voucher most of all.
      setCampaign(null);
      setFlow(emptyFlow);
      setHydrated(false);
      try {
        const [session, publicCampaign, progress] = await Promise.all([
          getVisitorSessionId(),
          getCampaign(slug, token),
          readHuntProgress(slug),
        ]);
        if (!active) return;
        setSessionId(session);
        setCampaign(publicCampaign);
        // Seeded before the snapshot, so the reconcile below judges the
        // remembered selection against what the server still holds instead of
        // treating this as a hunt that never started.
        setFlow((current) => ({ ...current, ...flowFromProgress(progress) }));
        setHydrated(true);

        // A returning visitor may already have attempts, or even a final voucher.
        // 404 just means they have not started this campaign yet.
        try {
          const snapshot = await getHuntState(slug, token);
          if (!active) return;
          // A campaign allows one final voucher per phone. Carrying it into the
          // flow is what stops the roulette from drawing again and failing with
          // E-DUPLICATE-FINAL — the spin is refused server-side either way, so the
          // app has to route to the issued voucher instead of asking for another.
          applySnapshot(snapshot, publicCampaign);
        } catch {
          // No hunt session yet — the landing screen's CTA creates one.
        }
      } catch (caught) {
        if (active) setError(caught);
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [applySnapshot, reloadToken, slug, token]);

  useEffect(
    () =>
      subscribeToHuntResetCompleted(() => {
        // The reset endpoint already cleared the authoritative server state.
        // Drop every local continuation marker so the campaign CTA starts a
        // fresh roulette instead of routing to a stale Results screen.
        setFlow({ ...emptyFlow });
        pendingAttempts.current.clear();
        pendingIssue.current = null;
        void clearHuntProgress();
        setError(null);
        // The hunt these screens describe no longer exists, so entering them
        // again has to start from the landing.
        entered.current = false;
        if (isHuntStepPath(pathnameRef.current)) {
          router.replace({ pathname: "/campaign/[slug]", params: { slug } });
        }
      }),
    [router, slug],
  );

  /**
   * A campaign opened while another one's stack is still standing inherits its
   * history.
   *
   * Expo Router keeps a single navigator for `campaign/[slug]` and swaps the
   * param rather than mounting a new one, so the screens the last campaign
   * pushed are still there: tapping a fresh campaign from the directory lands on
   * the previous one's reel or results list, showing this campaign's (empty)
   * state under the last one's heading. Keying the provider and the navigator by
   * slug does not help — the state is the router's, not React's.
   *
   * Runs once per campaign, because the provider is keyed by slug.
   */
  const markHuntEntered = useCallback(() => {
    entered.current = true;
  }, []);
  const huntWasEntered = useCallback(() => entered.current, []);

  /**
   * Records the screen the customer is on, so leaving mid-hunt returns them to
   * it. Driven by the pathname rather than by each screen reporting itself: one
   * writer cannot drift out of step with the routes, and it keeps recording
   * through a back navigation, which is how a booking gets changed.
   *
   * Paths outside this campaign are ignored — the navigator keeps a hunt stack
   * mounted while the customer is on another tab, and that background stack must
   * not rewrite progress from wherever they have gone since.
   */
  useEffect(() => {
    if (!hydrated) return;
    const step = stepFromPathname(pathname, slug);
    if (!step) return;

    setFlow((current) => (current.step === step ? current : { ...current, step }));
    void writeHuntProgress(slug, {
      step,
      ...(flow.selectedAttemptId ? { attemptId: flow.selectedAttemptId } : {}),
      ...(flow.selectedSlotId ? { slotId: flow.selectedSlotId } : {}),
      ...(flow.selectedDate ? { date: flow.selectedDate } : {}),
      ...(flow.guestCount ? { guestCount: flow.guestCount } : {}),
    });
  }, [
    flow.guestCount,
    flow.selectedAttemptId,
    flow.selectedDate,
    flow.selectedSlotId,
    hydrated,
    pathname,
    slug,
  ]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const save = useCallback((next: Partial<FlowState>) => {
    setFlow((current) => ({ ...current, ...next }));
  }, []);

  const settleVoucher = useCallback((issued: IssuedPayload) => {
    pendingIssue.current = { voucherId: issued.voucher.id, at: Date.now() };
    setFlow((current) => ({ ...current, issued }));
  }, []);

  const addAttempt = useCallback((attempt: VoucherAttempt) => {
    pendingAttempts.current.set(attempt.id, Date.now());
    setFlow((current) => ({
      ...current,
      attempts: mergeAttempts(current.attempts, [attempt]),
      selectedAttemptId: attempt.id,
      // A new draw invalidates any slot picked against the previous one.
      selectedSlotId: "",
      selectedDate: "",
      issued: null,
    }));
  }, []);

  const begin = useCallback(async () => {
    if (!token || !sessionId) return null;
    const state = await startHunt({ campaignSlug: slug, sessionId }, token);
    applySnapshot(state, campaign);
    return state;
  }, [applySnapshot, campaign, sessionId, slug, token]);

  const refreshSnapshot = useCallback(async () => {
    if (!token) return null;
    const snapshot = await getHuntState(slug, token);
    applySnapshot(snapshot, campaign);
    return snapshot;
  }, [applySnapshot, campaign, slug, token]);

  // Only ever resolves to an attempt that can still be selected, so a stale id
  // left in flow state cannot re-enable the screens that act on it.
  const selectedAttempt = useMemo(
    () =>
      flow.attempts.find(
        (attempt) =>
          attempt.id === flow.selectedAttemptId && isSelectableAttempt(attempt),
      ),
    [flow.attempts, flow.selectedAttemptId],
  );

  const slotById = useCallback(
    (id: string) => campaign?.slots.find((slot) => slot.id === id),
    [campaign],
  );

  const value = useMemo(
    () => ({
      slug,
      campaign,
      loading,
      error,
      reload,
      sessionId,
      flow,
      save,
      addAttempt,
      begin,
      refreshSnapshot,
      selectedAttempt,
      settleVoucher,
      markHuntEntered,
      huntWasEntered,
      slotById,
    }),
    [
      addAttempt,
      begin,
      campaign,
      error,
      flow,
      reload,
      loading,
      refreshSnapshot,
      save,
      selectedAttempt,
      sessionId,
      settleVoucher,
      markHuntEntered,
      huntWasEntered,
      slotById,
      slug,
    ],
  );

  return <HuntContext.Provider value={value}>{children}</HuntContext.Provider>;
}

export function useHunt(): HuntContextValue {
  const value = useContext(HuntContext);
  if (!value) {
    throw new Error("useHunt must be used inside HuntProvider");
  }
  return value;
}
