"use client";

/**
 * Signing in.
 *
 * <h2>Reverie's form, Clerk's credential</h2>
 *
 * <p>This was Clerk's `<SignIn />` component. What that bought was every edge
 * of a sign-in handled for free; what it cost was the first screen anybody sees
 * being visibly somebody else's — their type, their spacing, their name at the
 * foot of it. So the form is ours and the credential is still theirs: nothing
 * here stores a password or decides whether one is right. `useSignIn` is a
 * headless hook — it renders nothing — and every failure below comes back from
 * Clerk and is put into Reverie's words by `authErrorMessage`.
 *
 * <h2>Three states, one screen</h2>
 *
 * <p>Sign in, ask for a reset code, and set a new password. They are the same
 * form with different fields, so they are one component: a person who has just
 * typed their address into the first should not have to type it again into the
 * second, and separate routes would lose it.
 *
 * <p>The catch-all segment stays. Clerk still routes some sub-steps under this
 * path, and a plain `/sign-in` would 404 on them.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/auth-shell";
import {
  Field,
  FormError,
  GoogleButton,
  OrDivider,
  SubmitButton,
} from "@/components/auth/auth-form";
import { authErrorMessage, isAlreadySignedIn } from "@/lib/clerk-errors";
import { HOME } from "@/lib/routes";

export default function SignInPage() {
  /*
   * `useSearchParams` reads the URL, which does not exist while this is being
   * prerendered. Suspense is what Next asks for in exchange, and the fallback
   * is the frame with the form area blank -- so the page paints its heading and
   * its mark immediately rather than flashing an empty screen.
   */
  return (
    <React.Suspense fallback={<SignInFrame>{null}</SignInFrame>}>
      <SignInForm />
    </React.Suspense>
  );
}

function SignInFrame({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell
      eyebrow="Sign in"
      title="Welcome back."
      subtitle="Your meetings, transcripts and notes are where you left them."
      footer={
        <>
          New here?{" "}
          <Link href="/sign-up" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {children}
    </AuthShell>
  );
}

type Stage = "credentials" | "reset-request" | "reset-code";

function SignInForm() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const params = useSearchParams();

  const [stage, setStage] = React.useState<Stage>("credentials");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"form" | "google" | null>(null);

  /**
   * Where to land, and why it is checked.
   *
   * <p>The middleware puts the page you actually asked for on the URL, so a
   * bookmarked meeting opens the meeting rather than the top of the app. That
   * value arrives from the address bar, though, and handing an unchecked one to
   * `router.push` is an open redirect — a link to Reverie's own sign-in that
   * lands somebody on a copy of it. Only a path, and never `//`, which the
   * browser reads as a host.
   */
  const next = React.useMemo(() => {
    const asked = params.get("redirect_url") || "";
    return asked.startsWith("/") && !asked.startsWith("//") ? asked : HOME;
  }, [params]);

  function fail(cause: unknown) {
    if (isAlreadySignedIn(cause)) {
      router.push(next);
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
      // Leaves the app entirely and comes back at /sso-callback. Nothing after
      // this line runs on the way out.
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: next,
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
      if (stage === "credentials") {
        const attempt = await signIn.create({ identifier: email, password });
        if (attempt.status === "complete") {
          await setActive({ session: attempt.createdSessionId });
          router.push(next);
          return;
        }
        /*
         * Anything else is a step this form does not draw -- a second factor,
         * most likely. Rather than pretend, it says so and offers the way that
         * does work. This is the honest cost of owning the form.
         */
        setError("This account needs another step to sign in. Continue with Google, or reset your password.");
        setBusy(null);
        return;
      }

      if (stage === "reset-request") {
        await signIn.create({ strategy: "reset_password_email_code", identifier: email });
        setStage("reset-code");
        setBusy(null);
        return;
      }

      const reset = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code,
        password,
      });
      if (reset.status === "complete") {
        await setActive({ session: reset.createdSessionId });
        router.push(next);
        return;
      }
      setError("That did not complete. Start the reset again.");
      setBusy(null);
    } catch (cause) {
      fail(cause);
    }
  }

  return (
    <SignInFrame>
      <div className="space-y-6">
        {stage === "credentials" ? (
          <>
            <GoogleButton
              label="Continue with Google"
              onClick={withGoogle}
              busy={busy === "google"}
            />
            <OrDivider />
          </>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <FormError>{error}</FormError>

          {stage === "reset-code" ? (
            <>
              <p className="text-[13px] text-muted-foreground">
                We sent a code to <span className="text-foreground">{email}</span>.
              </p>
              <Field
                label="Code"
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder="123456"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Field
                label="New password"
                type="password"
                autoComplete="new-password"
                hint="At least 8 characters"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
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
              {stage === "credentials" ? (
                <Field
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  hint={
                    <button
                      type="button"
                      onClick={() => {
                        setStage("reset-request");
                        setError("");
                        setPassword("");
                      }}
                      className="underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot?
                    </button>
                  }
                />
              ) : null}
            </>
          )}

          <SubmitButton busy={busy === "form"} disabled={!isLoaded}>
            {stage === "credentials" ? "Sign in" : stage === "reset-request" ? "Send code" : "Set password and sign in"}
          </SubmitButton>

          {stage !== "credentials" ? (
            <button
              type="button"
              onClick={() => {
                setStage("credentials");
                setError("");
                setCode("");
                setPassword("");
              }}
              className="w-full text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Back to sign in
            </button>
          ) : null}
        </form>
      </div>
    </SignInFrame>
  );
}
