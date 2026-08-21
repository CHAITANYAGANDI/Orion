import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UsageResponse } from "@/lib/types";

/**
 * The meter at the foot of the rail.
 *
 * <p>Most of this is about which number it draws. Recallix enforces meetings —
 * the sixth of the month is refused with a 429 — and counts minutes without
 * ever checking them, so `Plan.FREE` reports a 60-minute limit that nothing
 * reads. A bar drawn against that number would fill up while nothing was wrong,
 * and somebody who believed it would stop recording meetings they were entitled
 * to record. That is the failure these guard against, and it is the reason the
 * bar is not on the figure a competitor's is.
 */
let usage: UsageResponse;
let error: boolean;

vi.mock("@/lib/api", () => ({
  useGetUsageQuery: () => ({ data: error ? undefined : usage, isError: error }),
}));

import { PlanUsage } from "@/components/plan-usage";

beforeEach(() => {
  error = false;
  usage = {
    plan: "FREE",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    meetingsUsed: 3,
    meetingsLimit: 5,
    aiMinutesUsed: 142,
    aiMinutesLimit: 60,
  };
});

describe("PlanUsage", () => {
  it("names the plan and what is left of the month", () => {
    render(<PlanUsage />);

    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.getByText("3 of 5")).toBeInTheDocument();
    expect(screen.getByText(/monthly meetings used/)).toBeInTheDocument();
  });

  it("counts the minutes without inventing a ceiling for them", () => {
    render(<PlanUsage />);

    // 142 against the plan's nominal 60, and nothing is wrong: minutes are
    // added up after each meeting and checked against nothing. Drawn as a
    // fraction this would read as more than twice over a limit that does not
    // exist.
    expect(screen.getByText("142 minutes transcribed")).toBeInTheDocument();
    expect(screen.queryByText(/of 60/)).not.toBeInTheDocument();
  });

  it("says what to do about it once the month is spent", () => {
    usage = { ...usage, meetingsUsed: 5 };

    render(<PlanUsage />);

    // The one moment there is something to say other than a statistic. Nothing
    // already processed goes away when the month turns over.
    expect(screen.getByText("5 of 5")).toBeInTheDocument();
    expect(screen.getByText(/None left until/)).toBeInTheDocument();
    expect(screen.queryByText(/minutes transcribed/)).not.toBeInTheDocument();
  });

  it("drops the ceiling for a plan that has none", () => {
    usage = { ...usage, plan: "PREMIUM", meetingsUsed: 21, meetingsLimit: -1 };

    render(<PlanUsage />);

    // -1 is the server's unlimited and has to survive the round trip as its own
    // state: "21 of -1" is the kind of thing that ships.
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.queryByText(/of -1/)).not.toBeInTheDocument();
    // And it is not called Basic, because its limits are not Basic's.
    expect(screen.getByText("Premium")).toBeInTheDocument();
    // The track sits at a token sliver forever on a plan with no ceiling, which
    // reads as a month barely started unless the line underneath says why.
    expect(screen.getByText(/no limit/)).toBeInTheDocument();
  });

  it("announces the count once, not twice", () => {
    render(<PlanUsage />);

    // The bar and the line under it are one fact. Left in the accessibility
    // tree the bar reads "sixty percent" immediately before "3 of 5" — the
    // vaguer version of the same number, first.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("leads to the page that explains the plan", () => {
    render(<PlanUsage />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings/plans");
  });

  it("holds its space while the figure is on its way", () => {
    usage = undefined as unknown as UsageResponse;

    const { container } = render(<PlanUsage />);

    // It sits under a flex-1 folder tree, so arriving late would shove the
    // account menu down at the moment somebody was reaching for it.
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says nothing at all when the figure cannot be read", () => {
    error = true;

    const { container } = render(<PlanUsage />);

    // A failed request is not worth a card above the account menu for the rest
    // of the session.
    expect(container).toBeEmptyDOMElement();
  });
});
