"use client";

import * as React from "react";
import { Provider as ReduxProvider } from "react-redux";
import { makeStore, type AppStore } from "@/lib/store";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

/**
 * App-wide client providers: Redux store, auth and toasts.
 *
 * No theme provider. Recallix has one palette, set on `:root` in globals.css,
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
        {children}
        {/* Position and styling live in the component, so there is one place
            a toast is described rather than a prop here and classes there. */}
        <Toaster />
      </AuthProvider>
    </ReduxProvider>
  );
}
