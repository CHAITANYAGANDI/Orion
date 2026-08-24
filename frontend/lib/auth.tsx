"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  AUTH_MODE,
  DEFAULT_DEV_USER,
  DEV_USER_KEY,
  authStore,
} from "@/lib/auth-store";
import { clearPreferences } from "@/lib/preference-store";

interface AuthContextValue {
  mode: "dev" | "clerk";
  /** Current user id (dev id in dev mode, Clerk user id in clerk mode). */
  userId: string;
  /** Dev-only: switch the active dev user. No-op in clerk mode. */
  setDevUserId: (id: string) => void;
  /**
   * Identifies the current sign-in, for anything stored in the browser that
   * must not outlive it — see lib/preference-store.ts.
   *
   * <p>Clerk's session id where there is one, because that is the thing that
   * actually changes when somebody signs out and back in; the dev user id in
   * dev mode, which has no sessions and so relies on `signOut` clearing up
   * after itself.
   *
   * <p>Empty until `isLoaded`. Nothing scoped to a sign-in should be read
   * before then, or it will be read under the wrong one.
   */
  sessionKey: string;
  isSignedIn: boolean;
  isLoaded: boolean;
  signOut?: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

/** Dev-mode provider: a persisted dev user id, sent as X-Dev-User. */
function DevAuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = React.useState(DEFAULT_DEV_USER);
  const [isLoaded, setIsLoaded] = React.useState(false);

  React.useEffect(() => {
    let stored = DEFAULT_DEV_USER;
    try {
      stored = window.localStorage.getItem(DEV_USER_KEY) || DEFAULT_DEV_USER;
    } catch {
      /* ignore */
    }
    authStore.devUserId = stored;
    setUserId(stored);
    setIsLoaded(true);
  }, []);

  const setDevUserId = React.useCallback((id: string) => {
    const next = id.trim() || DEFAULT_DEV_USER;
    authStore.devUserId = next;
    try {
      window.localStorage.setItem(DEV_USER_KEY, next);
    } catch {
      /* ignore */
    }
    setUserId(next);
  }, []);

  /**
   * Dev mode has no session to end, but it does have a stored identity — and
   * leaving it in place is not harmless. Closing an account calls `signOut`, and
   * with nothing behind it the browser carried on as the user it had just
   * deleted, re-provisioning that id on the next request. Forgetting the stored
   * id and reloading drops the cached data with it.
   */
  const signOut = React.useCallback(() => {
    try {
      window.localStorage.removeItem(DEV_USER_KEY);
    } catch {
      /* ignore */
    }
    // Dev mode signs back in as the same id, so the session key alone would not
    // notice this happened. See lib/preference-store.ts.
    clearPreferences();
    authStore.devUserId = DEFAULT_DEV_USER;
    window.location.href = "/";
  }, []);

  const value: AuthContextValue = {
    mode: "dev",
    userId,
    setDevUserId,
    // Dev has no sessions. The id is the only thing that distinguishes one
    // sign-in from another, and switching dev users is a sign-in.
    sessionKey: isLoaded ? userId : "",
    isSignedIn: true,
    isLoaded,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Clerk provider is loaded lazily and only in clerk mode, so dev builds never
// need a Clerk key and the Clerk SDK is not evaluated during SSR of dev pages.
const ClerkAuthProvider = dynamic(
  () => import("@/lib/clerk-auth").then((m) => m.ClerkAuthProvider),
  { ssr: false }
);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (AUTH_MODE === "clerk") {
    return <ClerkAuthProvider AuthContext={AuthContext}>{children}</ClerkAuthProvider>;
  }
  return <DevAuthProvider>{children}</DevAuthProvider>;
}

export { AuthContext };
export type { AuthContextValue };
