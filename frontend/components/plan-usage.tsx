"use client";

/**
 * What is left of the month, at the foot of the rail.
 *
 * <p>The shape is Otter's — the plan's name, a track beside it, and a bold
 * count under it — because it is the right shape: a quota is only useful where
 * somebody sees it before they start something, not on a settings tab they open
 * once.
 *
 * <p><strong>The bar is meetings, not minutes.</strong> Otter meters minutes
 * because minutes are what Otter sells. Recallix enforces one number and it is
 * the meeting count: `UsageLimitService.incrementMeetingsOrThrow` refuses the
 * sixth recording of the month with a 429. Minutes are added up after a meeting
 * finishes by `addAiMinutes`, which checks them against nothing — so `Plan.FREE`
 * carries an `aiMinutesLimit` of 60 that nothing in the codebase reads.
 *
 * <p>Drawing that 60 as a ceiling would be worse than leaving it out. The two
 * numbers contradict each other — five meetings a month at any ordinary length
 * is well past sixty minutes — so the bar would fill and stay full while
 * nothing was wrong, and the first person to believe it would stop recording
 * meetings they were entitled to record. Account Settings → Plans made the same
 * call for the same reason; this is the same decision in a smaller space.
 *
 * <p>So minutes are shown as what they are: a number that went up, with no
 * track around it.
 */

import * as React from "react";
import Link from "next/link";
import { useGetUsageQuery } from "@/lib/api";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
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

  const { meetingsUsed: used, meetingsLimit: limit } = data;
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
        {/* An unlimited plan says so, because otherwise the track above it is
            unreadable: it sits at a token sliver forever, which looks like a
            month barely started rather than one that cannot run out. */}
        monthly meetings used{limit < 0 ? " — no limit" : ""}
      </p>

      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {spent
          ? // What to do about it, rather than a statistic, at the one moment
            // there is something to do about it. Nothing already processed is
            // taken away when the month turns over.
            `None left until ${formatDate(data.periodEnd)}`
          : `${data.aiMinutesUsed} minutes transcribed`}
      </p>
    </Link>
  );
}
