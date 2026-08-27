import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppState } from "react-native";

import {
  getOrCreateRewardWallet,
  revokeSession,
  subscribeToUnauthorized,
  validateCustomerSession,
} from "@/api/client";
import { clearDevPoolIds } from "@/dev/devTools";
import { clearHuntProgress } from "@/hunt/progressStore";
import {
  acquirePushToken,
  registerPushToken,
  unregisterPushToken,
} from "@/notifications/push";

const TOKEN_KEY = "voucher_hunt_customer_token";
const PHONE_KEY = "voucher_hunt_customer_phone";
const SESSION_CHECK_INTERVAL_MS = 30_000;

export type LoyaltyAward = {
  balance: string;
  date: string;
  points: string;
};

type AuthContextValue = {
  /**
   * Whether the signed-in number is a configured developer account. Answered by
   * the server on every backend, because `__DEV__` knows only what kind of
   * bundle this is: false in a release build signed in as the developer account,
   * and true in a dev build signed in as anyone at all. Advisory — the tools
   * themselves are gated again on every request.
   */
  devTools: boolean;
  isLoading: boolean;
  loyaltyAward: LoyaltyAward | null;
  phone: string | null;
  token: string | null;
  completeSignIn: (phone: string, token: string) => Promise<void>;
  dismissLoyaltyAward: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [devTools, setDevTools] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loyaltyAward, setLoyaltyAward] = useState<LoyaltyAward | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const clearLocalSession = useCallback(async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(PHONE_KEY),
      // The rest is this *account's* state living on the device, and the next
      // sign-in may be a different person on the same handset. Left behind, a
      // resume point made the landing offer "Continue" into a hunt the new
      // account does not have — carrying them into a step screen instead of ever
      // calling `POST /hunt/start`, so no user row was written and the dashboard
      // never saw them — and a forced-pool choice made every draw send a
      // `devPoolId` the server refuses from anyone but a developer account.
      //
      // The visitor session id and the language choice deliberately stay: those
      // describe the install, not whoever is signed into it.
      clearHuntProgress(),
      clearDevPoolIds(),
    ]);
    setDevTools(false);
    setLoyaltyAward(null);
    setPhone(null);
    setToken(null);
  }, []);

  useEffect(
    () =>
      subscribeToUnauthorized(() => {
        void clearLocalSession();
      }),
    [clearLocalSession],
  );

  useEffect(() => {
    let active = true;

    void Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(PHONE_KEY),
    ])
      .then(([storedToken, storedPhone]) => {
        if (!active) return;
        if (storedToken && storedPhone) {
          setToken(storedToken);
          setPhone(storedPhone);
        }
      })
      .catch(() => {
        if (!active) return;
        setToken(null);
        setPhone(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setLoyaltyAward(null);
      return;
    }

    let active = true;

    // App launch is the earning event. The server awards at most one
    // app-use bonus per Manila calendar day, so retries are safe.
    void getOrCreateRewardWallet(token)
      .then((snapshot) => {
        if (!active || !snapshot.appUseAwardedNow) return;
        setLoyaltyAward({
          balance: snapshot.balance,
          date: snapshot.dailyStatus.date,
          points: snapshot.dailyStatus.appUsePoints,
        });
      })
      .catch(() => {
        // Loading Loyalty Points must not block the rest of the signed-in app.
      });

    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;

    let active = true;
    let requestInFlight = false;
    const checkSession = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const session = await validateCustomerSession(token);
        if (active) setDevTools(session.devTools === true);
      } catch {
        // Authenticated 401 responses are handled centrally by apiRequest.
        // Network failures must not sign the customer out.
      } finally {
        requestInFlight = false;
      }
    };

    // Once up front, not only on the interval: this call is now also what tells
    // a release build whether the dev panel belongs on the More tab, and waiting
    // a full tick to find out reads as the panel being broken.
    void checkSession();

    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active") {
          void checkSession();
        }
      },
    );
    const interval = setInterval(
      () => void checkSession(),
      SESSION_CHECK_INTERVAL_MS,
    );

    return () => {
      active = false;
      appStateSubscription.remove();
      clearInterval(interval);
    };
  }, [token]);

  const dismissLoyaltyAward = useCallback(() => {
    setLoyaltyAward(null);
  }, []);

  const completeSignIn = useCallback(async (nextPhone: string, nextToken: string) => {
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, nextToken),
      SecureStore.setItemAsync(PHONE_KEY, nextPhone),
    ]);
    setPhone(nextPhone);
    setToken(nextToken);
    // Prompt for notifications here rather than on first launch: the customer
    // has just verified an OTP, so the ask lands in context instead of cold.
    // Deliberately not awaited — sign-in must not wait on a permission dialog.
    void (async () => {
      try {
        const pushToken = await acquirePushToken();
        if (pushToken) await registerPushToken(pushToken, nextToken);
      } catch {
        // Push registration is optional. Never surface a rejected background
        // promise after a customer has successfully signed in.
      }
    })();
  }, []);

  const signOut = useCallback(async () => {
    const currentToken = token;
    try {
      if (currentToken) {
        // Drop the device first, while the token still authorizes the call —
        // otherwise this handset keeps receiving the previous owner's pushes.
        const pushToken = await acquirePushToken();
        if (pushToken) await unregisterPushToken(pushToken, currentToken);
        await revokeSession(currentToken);
      }
    } finally {
      await clearLocalSession();
    }
  }, [clearLocalSession, token]);

  const value = useMemo(
    () => ({
      devTools,
      isLoading,
      loyaltyAward,
      phone,
      token,
      completeSignIn,
      dismissLoyaltyAward,
      signOut,
    }),
    [
      completeSignIn,
      devTools,
      dismissLoyaltyAward,
      isLoading,
      loyaltyAward,
      phone,
      signOut,
      token,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}
