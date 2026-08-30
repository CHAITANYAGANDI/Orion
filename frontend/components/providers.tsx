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
        {/* Inside both providers because it needs the store and the session,
            and above `children` so a change of sign-in empties the API cache
            before anything below can read from it. The store outlives a
            sign-out -- it belongs to the React root, and neither half of a
            session change reloads the document. See the component. */}
        <SessionCacheGuard />
        {children}
        {/* Position and styling live in the component, so there is one place
            a toast is described rather than a prop here and classes there. */}
        <Toaster />
      </AuthProvider>
    </ReduxProvider>
  );
}
