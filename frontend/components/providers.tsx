"use client";

import * as React from "react";
import { Provider as ReduxProvider } from "react-redux";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { makeStore, type AppStore } from "@/lib/store";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

/** App-wide client providers: Redux store, auth, theme, and toasts. */
export function Providers({ children }: { children: React.ReactNode }) {
  const storeRef = React.useRef<AppStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = makeStore();
  }

  return (
    <ReduxProvider store={storeRef.current}>
      <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <AuthProvider>
          {children}
          <Toaster position="top-right" richColors />
        </AuthProvider>
      </NextThemesProvider>
    </ReduxProvider>
  );
}
