"use client";

/**
 * Plans.
 *
 * One plan, free, and the page says so in the first sentence rather than
 * leaving somebody to scroll for the catch. What used to be here was three
 * cards — Free, Pro at $19, Premium at $49 — with a Stripe checkout behind two
 * of them and feature lists nothing in the codebase backed. Reverie does not
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
        <h2 id="plan-heading" className="text-title-3 font-headline text-ink">
          Plans
        </h2>
        <p className="text-callout text-ink-3">
          Reverie has one plan. Everything the product does is in it.
        </p>
      </div>

      {/* The one grouped surface on this page, and it earns it: a plan IS one
          object, which is exactly what a radius and a fill are for. Everything
          else here is a section of a document and has neither. */}
      <div className="rounded-lg border border-line bg-surface-raised p-5">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-title-2 font-headline text-ink">{PLAN_NAME}</h3>
              <p className="mt-0.5 text-callout text-ink-3">
                For everyone. There is no other tier.
              </p>
              <p className="mt-3 text-display font-headline text-ink">Free</p>
            </div>
            <Badge variant="success">Your current plan</Badge>
          </div>

          <p className="mt-4 border-t border-line pt-4 text-callout text-ink-3">
            Nothing on this page is a trial and nothing expires. Two numbers
            bind — 100 transcribed minutes and 3 imports, for the life of the
            account rather than per month — and both are shown below against
            what you have used.
          </p>
        </div>
      </div>
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
      <h2 id="usage-heading" className="flex items-center gap-2 text-title-3 font-headline text-ink">
        <Gauge className="h-4 w-4 text-ink-3" /> This account
      </h2>

      {/* A section, not a card. Two figures and two bars are a reading of the
          account, and boxing them turns a preferences document into a
          dashboard. */}
      <div>
        <div className="space-y-5">
          {isLoading || !data ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div>
                <div className="mb-1.5 flex items-baseline justify-between gap-4 text-callout">
                  <span className="text-ink-2">Minutes transcribed</span>
                  <span className="tabular font-mono text-cap text-ink-4">
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
        </div>
      </div>
    </section>
  );
}

/** What you get, grouped the way somebody looks for it. */
function IncludedSection() {
  return (
    <section aria-labelledby="included-heading" className="space-y-4">
      <h2 id="included-heading" className="text-title-3 font-headline text-ink">
        What is included
      </h2>

      {/* Sub-sections of one document, not five cards. This is a list of what
          the product does; boxing each heading turns reading it into scanning
          a comparison table for a comparison that does not exist -- there is
          one plan. */}
      {INCLUDED.map((group) => (
        <div key={group.heading} className="border-b border-line pb-4 last:border-b-0">
          <h3 className="v2-label mb-2">{group.heading}</h3>
          <div className="space-y-2.5">
            {group.features.map((feature) => (
              <div key={feature.label} className="flex items-start gap-3 text-callout">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-ink-2">{feature.label}</span>
                  {feature.detail && (
                    <span className="block text-foot text-ink-4">{feature.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

