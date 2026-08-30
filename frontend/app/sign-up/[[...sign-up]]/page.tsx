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
 * moment somebody is deciding whether this product is worth the trouble. Where
 * the Clerk instance requires one anyway, it is derived from the address rather
 * than asked for; see `lib/clerk-signup.ts`. The same goes for a name here:
 * Google already knows it, and anyone signing up with an address is asked on
 * the first screen inside, where it is one field among the things that actually
 * configure their account.
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
 *
 * <h2>Verified is not the same as finished</h2>
 *
 * <p>The code proves the address; the sign-up completes only once Clerk has
 * every field it requires. This screen used to collapse the two and report the
 * gap as "check the code and try again", which sent people back to re-enter a
 * code that had already been accepted — and every attempt after the first, plus
 * Send another code, then failed with "This verification has already been
 * verified". There was no way out of the screen. So a verification that does
 * not complete the sign-up is now finished where it can be and named where it
 * cannot, and an already-verified answer is treated as the success it is.
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
import { authErrorMessage, isAlreadySignedIn, isAlreadyVerified } from "@/lib/clerk-errors";
import { blockedMessage, completedSession, fillableFields, type SignUpState } from "@/lib/clerk-signup";
import { WELCOME } from "@/lib/routes";

/*
 * Clerk's own types, reached through the hook rather than through an import.
 * `@clerk/types` is a transitive package here, and a direct import of one would
 * be a dependency this app does not declare.
 */
type SignUp = NonNullable<ReturnType<typeof useSignUp>["signUp"]>;

export default function SignUpPage() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const router = useRouter();

  const [stage, setStage] = React.useState<"details" | "verify">("details");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState<"form" | "google" | "resend" | null>(null);

  function fail(cause: unknown) {
    if (isAlreadySignedIn(cause)) {
      router.push(WELCOME);
      return;
    }
    setError(authErrorMessage(cause));
    setBusy(null);
  }

  /** Sign in and go, if the sign-up produced a session. Whether it did. */
  async function activate(state: SignUpState): Promise<boolean> {
    const session = completedSession(state);
    if (!session || !setActive) return false;
    await setActive({ session });
    router.push(WELCOME);
    return true;
  }

  /**
   * Where the sign-up actually is, asked of Clerk rather than assumed.
   *
   * <p>The in-memory resource is rewritten in place by every call, so it is
   * already right in the ordinary case — the exception is the response that
   * changed it going missing, which is one of the ways somebody ends up
   * attempting a verification twice. Hence the ask, and hence falling back to
   * what is in hand rather than turning a reload failure into a dead end of its
   * own.
   */
  async function reread(resource: SignUp): Promise<SignUpState> {
    try {
      return await resource.reload();
    } catch {
      return resource;
    }
  }

  /**
   * Finish, or say what is in the way. Never "check the code": by the time this
   * runs the code is the one thing known to have worked.
   */
  async function settle(resource: SignUp, state: SignUpState) {
    const fill = fillableFields(state, email);
    const current = fill ? await resource.update(fill) : state;

    if (await activate(current)) return;
    setError(blockedMessage(current));
    setBusy(null);
  }

  /** The code, and the state it leaves the sign-up in. */
  async function attempt(resource: SignUp): Promise<SignUpState> {
    try {
      return await resource.attemptEmailAddressVerification({ code });
    } catch (cause) {
      if (!isAlreadyVerified(cause)) throw cause;
      // Clerk has already taken this code. That is a success reported as a
      // failure, so read where it got to and carry on from there.
      return await reread(resource);
    }
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
    setSent(false);
    setBusy("form");

    try {
      if (stage === "details") {
        const created = await signUp.create({ emailAddress: email, password });
        // Anything the instance requires that this form does not ask for, filled
        // in before a code is spent rather than after.
        const fill = fillableFields(created, email);
        const ready = fill ? await signUp.update(fill) : created;

        // An instance that does not verify addresses is finished here. Most are
        // not, and fall through to the code.
        if (await activate(ready)) return;

        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setStage("verify");
        setBusy(null);
        return;
      }

      await settle(signUp, await attempt(signUp));
    } catch (cause) {
      fail(cause);
    }
  }

  /** Another code, or the reason there is no such thing. */
  async function send(resource: SignUp) {
    try {
      await resource.prepareEmailAddressVerification({ strategy: "email_code" });
    } catch (cause) {
      if (!isAlreadyVerified(cause)) throw cause;
      // There is no code left to send — the address is confirmed. Whatever is
      // still in the way is not here, so go and deal with it.
      await settle(resource, await reread(resource));
      return;
    }
    // Said out loud. A button that silently succeeds is a button that looks
    // broken, and the next thing anybody does is press it again.
    setSent(true);
    setBusy(null);
  }

  async function resend() {
    if (!isLoaded || busy) return;
    setError("");
    setSent(false);
    setBusy("resend");
    try {
      await send(signUp);
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

          {sent ? (
            <p
              role="status"
              className="rounded-lg border bg-card px-3.5 py-2.5 text-[13px] text-muted-foreground"
            >
              A new code is on its way. The older one no longer works.
            </p>
          ) : null}

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

          <SubmitButton busy={busy === "form"} disabled={!isLoaded || busy === "resend"}>
            {stage === "details" ? "Create account" : "Confirm and continue"}
          </SubmitButton>

          {stage === "verify" ? (
            <div className="flex items-center justify-between text-[13px] text-muted-foreground">
              <button
                type="button"
                onClick={resend}
                disabled={busy !== null}
                className="underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60 disabled:hover:no-underline"
              >
                {busy === "resend" ? "Sending…" : "Send another code"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage("details");
                  setError("");
                  setSent(false);
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
