"use client";

/**
 * Security — how you get in.
 *
 * <p>This tab used to carry the whole privacy overview as well: an inventory of
 * what Recallix held, how the bucket was configured, which share links were
 * live, the retention dials, the account archive and the close-account control.
 * All of it was removed on request, leaving sign-in.
 *
 * <p>What went with it is worth writing down, because most of it was not
 * removed from the server. {@code GET /privacy}, {@code PATCH /privacy/retention},
 * {@code POST /privacy/links/revoke-all} and {@code DELETE /privacy/account}
 * all still exist and still work; the retention job still runs each night
 * against whatever policy is stored. They have no control in the interface now,
 * so retention can only be changed, and an account can only be closed, by
 * calling the API directly.
 *
 * <p>The exception is {@code GET /privacy/export}, the whole account as a zip.
 * That one is gone from the server too, so there is no longer an API call to
 * fall back to: a meeting still exports in four formats from the meeting page,
 * and there is nothing that exports all of them at once.
 */

import { Lock, ExternalLink } from "lucide-react";
import { useGetPrivacyOverviewQuery } from "@/lib/api";
import { ACCOUNT_PORTAL_URL } from "@/lib/auth-store";
import type { SignInFacts } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SecurityTab() {
  const overview = useGetPrivacyOverviewQuery();

  if (overview.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!overview.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load your data. Reload the page to try again.
      </p>
    );
  }

  // Only the sign-in facts are read now. The rest of the overview — the counts,
  // the bucket configuration, the live links, the retention policy — is still
  // sent by the endpoint and no longer has anywhere to be shown.
  const { signIn } = overview.data;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">How you get in.</p>

      <TwoFactorCard signIn={signIn} />

    </div>
  );
}

/**
 * Two-factor authentication.
 *
 * <p>The honest version of a section every product has. Recallix does not
 * authenticate anybody: there is no password column, no login form and no
 * session to establish — a request arrives carrying a token Clerk already
 * issued, and the filter verifies it. A second factor is therefore something
 * that happens before Recallix is involved at all.
 *
 * <p>Which is why there is no enrolment here. Building a TOTP flow in this
 * application — secret, QR code, verify once — would produce a factor that
 * sign-in never checks, and a switch reading "two-factor authentication is on"
 * over an account that any valid Clerk session still opens. That is worse than
 * the absence: it is a security control that is wrong in the direction people
 * rely on.
 *
 * <p>So this reports and points. The status comes from what the credential
 * asserted, and stays unknown when it asserted nothing rather than guessing at
 * "off" — telling somebody who has 2FA on that they do not is the one error
 * this card must never make.
 */
function TwoFactorCard({ signIn }: { signIn: SignInFacts }) {
  const dev = !signIn.managedExternally;
  const on = signIn.secondFactor === true;
  const off = signIn.secondFactor === false;

  const status = dev
    ? "This is a development session — there is no sign-in"
    : on
      ? "Two-factor authentication is turned on"
      : off
        ? "Two-factor authentication is turned off"
        : "Your sign-in provider hasn't said";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4 text-primary" /> Two-factor Authentication
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Adds a second step to signing in — a code from your phone as well as
          your password — so a stolen password is not enough on its own.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span
              aria-hidden
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                on ? "bg-success" : off ? "bg-destructive" : "bg-muted-foreground",
              )}
            />
            {status}
          </span>

          {!dev && ACCOUNT_PORTAL_URL && (
            <Button variant={on ? "outline" : "default"} size="sm" asChild>
              <a href={ACCOUNT_PORTAL_URL} target="_blank" rel="noopener noreferrer">
                {on ? "Manage" : "Set up"}
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>

        {/* Why the button is somewhere else, or missing. Each of these is a
            different true situation and none of them is "not implemented yet". */}
        <p className="text-xs text-muted-foreground">
          {dev ? (
            <>
              Nothing signs in here: a development session is identified by a
              header, so there is no password and no second factor to add. In a
              deployment with a sign-in provider configured, this is where its
              status appears.
            </>
          ) : ACCOUNT_PORTAL_URL ? (
            <>
              Set up and turned off at your sign-in provider, not here — Recallix
              only ever sees the token it issues, so a factor enrolled in this
              app is one nothing would check.
              {!on && !off && (
                <>
                  {" "}
                  The status above is unknown because the token carries no claim
                  about it; adding <code>two_factor_enabled</code> to the JWT
                  template makes it readable.
                </>
              )}
            </>
          ) : (
            <>
              Managed at your sign-in provider. No account page has been
              configured for this deployment, so there is no link to send you to
              — set <code>NEXT_PUBLIC_ACCOUNT_PORTAL_URL</code> and a button
              appears here.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
