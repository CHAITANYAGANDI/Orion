"use client";

/**
 * The half-second between Google and Orion.
 *
 * <p>`authenticateWithRedirect` sends somebody out to Google and Google sends
 * them back here with a token in the URL. Clerk's
 * `AuthenticateWithRedirectCallback` is what exchanges it for a session — it is
 * headless, renders nothing at all, and then navigates on. So this route is a
 * screen with a component doing invisible work underneath it.
 *
 * <p>Which is why it is worth drawing rather than leaving blank. This is the
 * first thing a new account sees after choosing Google, on the slowest step of
 * the flow, and an empty dark page for a second reads as something having gone
 * wrong.
 *
 * <p>It must be reachable while signed out — the whole point is that the
 * session does not exist yet — so it is listed as public in the middleware.
 */

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Mic } from "lucide-react";
import { HOME, WELCOME } from "@/lib/routes";

export default function SsoCallbackPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      {/*
        Where to go if Clerk cannot tell which flow this was. A returning
        sign-in goes home; a brand-new account goes to the welcome screen. Both
        are fallbacks: the redirect the flow started with normally wins.
      */}
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl={HOME}
        signUpFallbackRedirectUrl={WELCOME}
      />

      <span className="flex h-9 w-9 animate-pulse items-center justify-center rounded-[9px] bg-primary text-primary-foreground motion-reduce:animate-none">
        <Mic className="h-4 w-4" />
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Signing you in
      </p>
    </div>
  );
}
