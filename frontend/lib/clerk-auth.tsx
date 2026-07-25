"use client";

// Loaded lazily by lib/auth.tsx ONLY when NEXT_PUBLIC_AUTH_MODE=clerk.
// Dev builds never evaluate this module, so no Clerk key is required to run.

import * as React from "react";
import { ClerkProvider, useAuth as useClerkAuth } from "@clerk/nextjs";
import { authStore } from "@/lib/auth-store";
import type { AuthContextValue } from "@/lib/auth";

type Ctx = React.Context<AuthContextValue | null>;

function ClerkBridge({
  AuthContext,
  children,
}: {
  AuthContext: Ctx;
  children: React.ReactNode;
}) {
  const { getToken, userId, isSignedIn, isLoaded, signOut } = useClerkAuth();

  React.useEffect(() => {
    authStore.tokenGetter = () => getToken();
    return () => {
      authStore.tokenGetter = null;
    };
  }, [getToken]);

  const value: AuthContextValue = {
    mode: "clerk",
    userId: userId ?? "",
    setDevUserId: () => {
      /* no-op in clerk mode */
    },
    isSignedIn: Boolean(isSignedIn),
    isLoaded,
    signOut: () => {
      void signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function ClerkAuthProvider({
  AuthContext,
  children,
}: {
  AuthContext: Ctx;
  children: React.ReactNode;
}) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "";
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkBridge AuthContext={AuthContext}>{children}</ClerkBridge>
    </ClerkProvider>
  );
}
