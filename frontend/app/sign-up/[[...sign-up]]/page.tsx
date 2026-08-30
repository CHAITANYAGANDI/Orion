"use client";

/**
 * Creating an account.
 *
 * <h2>What it asks for, and what it refuses to</h2>
 *
 * <p>An address and a password. That is the whole form.
 *
 * <p><b>No username.</b> Orion has nowhere to put one: there is no profile to
 * visit, no @mention, no sharing, and one account per workspace — so a username
 * would be a required field that nothing ever reads back, invented at the exact
 * moment somebody is deciding whether this product is worth the trouble. The
 * same goes for a name here: Google already knows it, and anyone signing up
 * with an address is asked on the first screen inside, where it is one field
 * among the things that actually configure their account.
 *
 * <p><b>No card, no company, no team size.</b> The allowance is fixed and the
 * account is free; asking anything to qualify a lead would be asking for
 * something Orion does not use.
 *
 * <h2>The two roads</h2>
 *
 * <p>Google, which is a redirect and comes back at `/sso-callback`. Or an
 * address, which Clerk verifies with a six-digit code — that step is not
 * optional and not something this form can skip, so it is drawn properly rather
 * than as an interstitial.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/auth-shell";
import {
  Field,
  FormError,
  GoogleButton,
  OrDivider,
  SubmitButton,
} from "@/components/auth/auth-form";
import { authErrorMessage, isAlreadySignedIn } from "@/lib/clerk-errors";
import { WELCOME } from "@/lib/routes";

export default function SignUpPage() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const router = useRouter();

  const [stage, setStage] = React.useState<"details" | "verify">("details");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"form" | "google" | null>(null);

  function fail(cause: unknown) {
    if (isAlreadySignedIn(cause)) {
      router.push(WELCOME);
      return;
    }
    setError(authErrorMessage(cause));
    setBusy(null);
  }

  async function withGoogle() {
    if (!isLoaded) return;
    setError("");
    setBusy("google");
    try {
      await signUp.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        // New accounts land on the welcome flow. Somebody who already had one
        // and pressed the wrong button lands there too and skips through it in
        // two clicks, which is better than being told off.
        redirectUrlComplete: WELCOME,
      });
    } catch (cause) {
      fail(cause);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isLoaded || busy) return;
    setError("");
    setBusy("form");

    try {
      if (stage === "details") {
        await signUp.create({ emailAddress: email, password });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setStage("verify");
        setBusy(null);
        return;
      }

      const attempt = await signUp.attemptEmailAddressVerification({ code });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
        router.push(WELCOME);
        return;
      }
      setError("That did not complete the sign-up. Check the code and try again.");
      setBusy(null);
    } catch (cause) {
      fail(cause);
    }
  }

  async function resend() {
    if (!isLoaded) return;
    setError("");
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    } catch (cause) {
      fail(cause);
    }
  }

  return (
    <AuthShell
      eyebrow={stage === "details" ? "Create account" : "Check your email"}
      title={stage === "details" ? "Start with Orion." : "Confirm it is you."}
      subtitle={
        stage === "details" ? (
          <>100 transcription minutes and 3 imports, for the life of the account. No card.</>
        ) : (
          <>
            We sent a six-digit code to <span className="text-foreground">{email}</span>.
          </>
        )
      }
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <div className="space-y-6">
        {stage === "details" ? (
          <>
            <GoogleButton label="Continue with Google" onClick={withGoogle} busy={busy === "google"} />
            <OrDivider />
          </>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <FormError>{error}</FormError>

          {stage === "details" ? (
            <>
              <Field
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Field
                label="Password"
                type="password"
                autoComplete="new-password"
                hint="At least 8 characters"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
            <Field
              label="Code"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          )}

          {/*
            Clerk mounts its bot check into this element. It is invisible unless
            a sign-up actually looks automated, and without the element Clerk
            has nowhere to put the challenge and refuses the sign-up outright.
          */}
          <div id="clerk-captcha" />

          <SubmitButton busy={busy === "form"} disabled={!isLoaded}>
            {stage === "details" ? "Create account" : "Confirm and continue"}
          </SubmitButton>

          {stage === "verify" ? (
            <div className="flex items-center justify-between text-[13px] text-muted-foreground">
              <button
                type="button"
                onClick={resend}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Send another code
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage("details");
                  setError("");
                  setCode("");
                }}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              By creating an account you agree that recordings you upload are processed to produce
              transcripts and summaries. You can delete any of it, at any time.
            </p>
          )}
        </form>
      </div>
    </AuthShell>
  );
}
