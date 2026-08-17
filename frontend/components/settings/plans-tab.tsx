"use client";

/**
 * Plans.
 *
 * One plan, free, and the page says so in the first sentence rather than
 * leaving somebody to scroll for the catch. What used to be here was three
 * cards — Free, Pro at $19, Premium at $49 — with a Stripe checkout behind two
 * of them and feature lists nothing in the codebase backed. Recallix does not
 * have two more products; it has one, and a pricing table that implies
 * otherwise is a promise made on behalf of work that does not exist.
 *
 * What replaces it is the same shape as the Integrations tab, for the same
 * reason: what is included, at the limits actually enforced, followed by what
 * is not included and why. The second list is the one that earns the page. A
 * reader arriving from a competitor assumes a bot joins their calls and an app
 * sits on their phone, and both assumptions fail quietly and late — after a
 * meeting they expected to be recorded.
 *
 * The usage figures are read from `/usage` rather than restated from the
 * feature list, because a limit somebody is near is the only number on this
 * page they need today.
 */

import * as React from "react";
import Link from "next/link";
import { Check, Ban, Gauge } from "lucide-react";
import { useGetUsageQuery } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { INCLUDED, NOT_INCLUDED, PLAN_NAME, usageFraction, usageLabel } from "@/lib/plan";

export function PlansTab() {
  return (
    <div className="space-y-10">
      <PlanCard />
      <UsageSection />
      <IncludedSection />
      <NotIncludedSection />
    </div>
  );
}

/**
 * The plan itself.
 *
 * No price toggle, no annual discount and no second card to compare against —
 * all three are furniture that only means something when there is a decision to
 * make. "Your current plan" stays, because it answers the question somebody
 * opened the tab with.
 */
function PlanCard() {
  return (
    <section aria-labelledby="plan-heading" className="space-y-3">
      <div>
        <h2 id="plan-heading" className="text-lg font-semibold">
          Plans
        </h2>
        <p className="text-sm text-muted-foreground">
          Recallix has one plan. Everything the product does is in it.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold">{PLAN_NAME}</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                For everyone. There is no other tier.
              </p>
              <p className="mt-3 text-3xl font-bold">Free</p>
            </div>
            <Badge variant="success">Your current plan</Badge>
          </div>

          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            Nothing on this page is a trial and nothing expires. The one number
            that binds is five meetings a month, and it is shown below against
            what you have used.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * This month.
 *
 * Two figures that are deliberately not presented alike, because only one of
 * them stops anything. The meeting count is enforced — a sixth recording is
 * refused with a 429 — so it gets a bar. Minutes are added up after a meeting
 * finishes and never checked against anything, so showing them inside a
 * progress track would invent a ceiling that does not exist.
 */
function UsageSection() {
  const { data, isLoading } = useGetUsageQuery();

  return (
    <section aria-labelledby="usage-heading" className="space-y-3">
      <h2 id="usage-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Gauge className="h-4 w-4 text-muted-foreground" /> This month
      </h2>

      <Card>
        <CardContent className="space-y-5 pt-6">
          {isLoading || !data ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div>
                <div className="mb-1.5 flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium">Meetings</span>
                  <span className="text-muted-foreground">
                    {usageLabel(data.meetingsUsed, data.meetingsLimit)}
                  </span>
                </div>
                <Progress
                  value={usageFraction(data.meetingsUsed, data.meetingsLimit)}
                  aria-label="Meetings used this month"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Recording and importing both count. Resets on{" "}
                  {formatDate(data.periodEnd)}, and nothing already processed is
                  removed when it does.
                </p>
              </div>

              <div className="border-t pt-4">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium">Minutes transcribed</span>
                  <span className="text-muted-foreground">{data.aiMinutesUsed}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Counted so you can see it, not capped. Recallix does not stop
                  transcribing at a number of minutes — the meeting count above
                  is the only ceiling.
                </p>
              </div>

              {data.plan !== "FREE" && (
                <p className="border-t pt-4 text-xs text-muted-foreground">
                  This account still carries a{" "}
                  <span className="font-medium">{data.plan}</span> plan from an
                  earlier build of Recallix, which is why the figures above may
                  not match the five-meeting limit. Its limits are what apply to
                  you.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** What you get, grouped the way somebody looks for it. */
function IncludedSection() {
  return (
    <section aria-labelledby="included-heading" className="space-y-4">
      <h2 id="included-heading" className="text-lg font-semibold">
        What is included
      </h2>

      {INCLUDED.map((group) => (
        <Card key={group.heading}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{group.heading}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {group.features.map((feature) => (
              <div key={feature.label} className="flex items-start gap-3 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                <span>
                  <span className="block">{feature.label}</span>
                  {feature.detail && (
                    <span className="block text-muted-foreground">{feature.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

/**
 * What is not here.
 *
 * Last, and not hidden behind a disclosure, because a reader who stops before
 * it is exactly the reader it was written for.
 */
function NotIncludedSection() {
  return (
    <section aria-labelledby="not-included-heading" className="space-y-3">
      <h2 id="not-included-heading" className="text-lg font-semibold">
        What Recallix does not do
      </h2>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {NOT_INCLUDED.map((item) => (
            <div key={item.label} className="flex items-start gap-3 text-sm">
              <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="block font-medium">{item.label}</span>
                {item.detail && (
                  <span className="block text-muted-foreground">{item.detail}</span>
                )}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        What Recallix holds of yours, and how to take it with you or delete it,
        is on the{" "}
        <Link href="/settings/security" className="text-primary underline-offset-2 hover:underline">
          Security tab
        </Link>
        .
      </p>
    </section>
  );
}
