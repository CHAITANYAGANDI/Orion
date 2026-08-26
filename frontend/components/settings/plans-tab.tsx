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
 * reason: what is included, at the limits actually enforced.
 *
 * The usage figures are read from `/usage` rather than restated from the
 * feature list, because a limit somebody is near is the only number on this
 * page they need today.
 */

import * as React from "react";
import { Check, Gauge } from "lucide-react";
import { useGetUsageQuery } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { INCLUDED, PLAN_NAME, usageFraction, usageLabel } from "@/lib/plan";

export function PlansTab() {
  return (
    <div className="space-y-10">
      <PlanCard />
      <UsageSection />
      <IncludedSection />
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
            Nothing on this page is a trial and nothing expires. Two numbers
            bind — 100 transcribed minutes and 3 imports, for the life of the
            account rather than per month — and both are shown below against
            what you have used.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * What this account has spent of what it is allowed.
 *
 * Both figures are enforced now, so both get a bar: 100 transcribed minutes and
 * 3 imports, for the life of the account. It used to be one bar — five meetings
 * a calendar month — beside a minute count with no ceiling, because minutes
 * were tallied and checked against nothing.
 *
 * The meeting count is gone from here entirely. Nothing refuses a recording for
 * being the eleventh; what it costs is its minutes, and those are the bar above.
 */
function UsageSection() {
  const { data, isLoading } = useGetUsageQuery();

  return (
    <section aria-labelledby="usage-heading" className="space-y-3">
      <h2 id="usage-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Gauge className="h-4 w-4 text-muted-foreground" /> This account
      </h2>

      <Card>
        <CardContent className="space-y-5 pt-6">
          {isLoading || !data ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div>
                <div className="mb-1.5 flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium">Minutes transcribed</span>
                  <span className="text-muted-foreground">
                    {usageLabel(data.minutesUsed, data.minutesLimit)}
                  </span>
                </div>
                <Progress
                  value={usageFraction(data.minutesUsed, data.minutesLimit)}
                  aria-label="Minutes transcribed"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Recording and importing both spend them, and this is the whole
                  allowance — it is not monthly and there is no date it comes
                  back. {data.meetingsUsed} meeting
                  {data.meetingsUsed === 1 ? "" : "s"} so far, which nothing
                  limits: what a recording costs is its length.
                </p>
              </div>

              <div className="border-t pt-4">
                <div className="mb-1.5 flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium">Imports</span>
                  <span className="text-muted-foreground">
                    {usageLabel(data.importsUsed, data.importsLimit)}
                  </span>
                </div>
                <Progress
                  value={usageFraction(data.importsUsed, data.importsLimit)}
                  aria-label="Imports used"
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Files you upload. Recording in the browser is not one of these
                  — it spends minutes only.
                </p>
              </div>
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

