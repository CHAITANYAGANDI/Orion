"use client";

/**
 * What is left of the allowance, at the foot of the rail.
 *
 * <p>The shape is Otter's — the plan's name, a track beside it, and a bold
 * count under it — because it is the right shape: an allowance is only useful
 * where somebody sees it before they start something, not on a settings tab
 * they open once.
 *
 * <p><strong>The bar is minutes.</strong> It used to be the meeting count,
 * because that was the only number the server enforced; minutes were added up
 * and checked against nothing, so drawing them as a fraction would have
 * invented a ceiling. Both halves of that have changed. The allowance is now
 * 100 transcribed minutes and 3 imports for the life of the account
 * (`UsageLimitService`), the meeting count is capped by nothing at all, and the
 * bar is on the number that actually runs out.
 *
 * <p><strong>And there is no reset date.</strong> This said "None left until
 * 1 September" when the month was spent, which was the useful thing to say
 * about a monthly quota and would be a lie about this one. Nothing arrives on
 * the 1st. What it says instead is what is true: the allowance is the account's
 * whole allowance, and nothing already transcribed is taken away.
 */

import * as React from "react";
import Link from "next/link";
import { useGetUsageQuery } from "@/lib/api";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { planLabel, quotaCount, usageFraction } from "@/lib/plan";

export function PlanUsage({ onNavigate }: { onNavigate?: () => void }) {
  const { data, isError } = useGetUsageQuery();

  // Nothing at all if it cannot be read. A rail footer is not the place to
  // report that one request failed, and an error card sitting above the account
  // menu for the whole session is worse than the absence of a figure.
  if (isError) return null;

  // Held space rather than nothing, because this sits under a `flex-1` folder
  // tree: appearing late would shove the account menu down at the moment
  // somebody was reaching for it.
  if (!data) return <Skeleton className="mx-3 mb-3 h-[4.75rem] rounded-lg" />;

  const { minutesUsed: used, minutesLimit: limit } = data;
  const spent = limit >= 0 && used >= limit;

  return (
    <Link
      href="/settings/plans"
      onClick={onNavigate}
      className="mx-3 mb-3 block rounded-lg border bg-muted/40 p-3 transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{planLabel(data.plan)}</span>
        {/* Out of the accessibility tree on purpose. The line underneath is the
            same fact in words, and announced together they are "sixty percent"
            followed by "3 of 5" — two readings of one number, the vaguer one
            first. */}
        <Progress
          value={usageFraction(used, limit)}
          className="h-1.5 flex-1"
          aria-hidden
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{quotaCount(used, limit)}</span>{" "}
        {/* An account with no ceiling says so, because otherwise the track above
            it is unreadable: it sits at a token sliver forever, which looks
            like an allowance barely touched rather than one that cannot run
            out. No plan has that any more, and the branch stays because -1 is
            still what the field means and a row can still carry it. */}
        minutes transcribed{limit < 0 ? " — no limit" : ""}
      </p>

      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {spent
          ? // What it means, rather than a statistic, at the one moment it
            // means something. There is no date to wait for — this is the
            // account's whole allowance — and nothing already transcribed goes
            // away now that it is spent.
            "That is the whole allowance. Nothing already transcribed is removed."
          : `${quotaCount(data.importsUsed, data.importsLimit)} imports used`}
      </p>
    </Link>
  );
}
