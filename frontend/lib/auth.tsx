"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  AUTH_MODE,
  DEFAULT_DEV_USER,
  DEV_USER_KEY,
  authStore,
  publishAuthState,
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
  /**
   * Who the person is, as the identity provider knows them.
   *
   * <h3>Why this is here rather than fetched</h3>
   *
   * <p>The account button showed `user_3IUiqZSNuF0gbjwWA...` — an opaque id
   * that tells the reader nothing and, worse, looks like somebody else's
   * account. It fell back to the id because the two things it preferred were
   * both empty: `users.display_name` is only ever set by hand in Settings, and
   * `users.email` is null for most Clerk accounts, because Clerk's default
   * session token carries no email claim (see `EMAIL_CLAIMS` in
   * AuthenticationFilter — it needs a JWT template).
   *
   * <p>Meanwhile the browser already had all of it. Signing in with Google
   * hands Clerk a name, an address and a picture, and `useUser()` has them
   * client-side with no request at all. So the provider carries them, and the
   * name somebody chose in Settings still wins where they have chosen one.
   *
   * <p>Empty strings rather than nulls: every consumer is rendering these into
   * a string, and `""` is falsy in the one expression that matters.
   */
  profile: UserProfile;
}

/** What the identity provider knows about the person signed in. */
export interface UserProfile {
  /** "Ada Lovelace", or "" if the provider has no name for them. */
  name: string;
  /** Their primary address, or "". */
  email: string;
  /** A photo URL, or "". */
  imageUrl: string;
}

/** Dev mode has an id and nothing else — there is no provider to ask. */
export const NO_PROFILE: UserProfile = { name: "", email: "", imageUrl: "" };

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
    /*
     * Switching dev user is a change of tenant, with no navigation and no
     * sign-in to notice it -- so it is published as a new generation for the
     * same reason a Clerk session change is. The gate closes, SessionCacheGuard
     * empties the previous user's API cache and claims the new one, and the
     * gate reopens. Without this the next request is answered from the
     * previous dev user's entries.
     *
     * The token half stays `proven`: dev mode's header comes from
     * `authStore.devUserId`, which was set on the line above, so there is
     * nothing asynchronous to prove.
     */
    publishAuthState({ sessionId: `dev:${next}`, phase: "proven" });
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
    // Nothing to know. Dev mode has an id, and the account button says
    // "Development session" under it rather than pretending to a name.
    profile: NO_PROFILE,
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
