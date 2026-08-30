"use client";

import * as React from "react";
import { Provider as ReduxProvider } from "react-redux";
import { makeStore, type AppStore } from "@/lib/store";
import { AuthProvider } from "@/lib/auth";
import { SessionCacheGuard } from "@/components/session-cache-guard";
import { Toaster } from "@/components/ui/sonner";

/**
 * App-wide client providers: Redux store, auth and toasts.
 *
 * No theme provider. Orion has one palette, set on `:root` in globals.css,
 * so there is nothing to switch and nothing to restore from storage — which
 * also removes the flash of the wrong theme that any of this would reintroduce.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const storeRef = React.useRef<AppStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = makeStore();
  }

  return (
    <ReduxProvider store={storeRef.current}>
      <AuthProvider>
        {/* Inside both providers because it needs the store and the session.
            Its position among the siblings is NOT what makes it safe: it used
            to be declared here on the theory that "before `children`" meant
            "before children can read the cache", which is a property of one
            commit's effect order and says nothing about the commit in which
            the gate opens. What makes it safe is that it publishes cache
            ownership into the same state machine `AuthGate` reads, and the
            gate will not open without it. See the component. */}
        <SessionCacheGuard />
        {children}
        {/* Position and styling live in the component, so there is one place
            a toast is described rather than a prop here and classes there. */}
        <Toaster />
      </AuthProvider>
    </ReduxProvider>
  );
}
