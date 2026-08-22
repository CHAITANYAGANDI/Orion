import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UsageResponse } from "@/lib/types";

/**
 * The meter at the foot of the rail.
 *
 * <p>Most of this is about which number it draws, and the answer changed. The
 * allowance was five meetings a calendar month, with minutes tallied and
 * checked against nothing; it is now 100 transcribed minutes and 3 imports for
 * the life of the account. So the bar is on minutes — the number that actually
 * runs out — and the second line is imports.
 *
 * <p>The thing worth guarding is the sentence at the bottom. It used to read
 * "None left until 1 September", which was the useful thing to say about a
 * monthly quota and would be a lie about this one: nothing arrives on the 1st.
 * Somebody who believes it waits for an allowance that is never coming back.
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
    minutesUsed: 42,
    minutesLimit: 100,
    importsUsed: 2,
    importsLimit: 3,
    meetingsUsed: 11,
  };
});

describe("PlanUsage", () => {
  it("names the plan and how much of the allowance is gone", () => {
    render(<PlanUsage />);

    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.getByText("42 of 100")).toBeInTheDocument();
    expect(screen.getByText(/minutes transcribed/)).toBeInTheDocument();
  });

  it("shows the imports underneath, which are the other thing that runs out", () => {
    render(<PlanUsage />);

    // Three files, ever. It is the allowance somebody hits first and the one
    // with no way to see it coming — a recording spends minutes it can feel
    // the length of, an import spends a whole slot whatever the file is.
    expect(screen.getByText("2 of 3 imports used")).toBeInTheDocument();
  });

  it("does not offer a date when the allowance is spent, because there is none", () => {
    usage = { ...usage, minutesUsed: 100 };

    render(<PlanUsage />);

    // This said "None left until 1 September" when it was a monthly quota.
    // Saying it here would have somebody waiting for the 1st of a month that
    // brings nothing.
    expect(screen.getByText("100 of 100")).toBeInTheDocument();
    expect(screen.getByText(/whole allowance/)).toBeInTheDocument();
    expect(screen.queryByText(/until/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/imports used/)).not.toBeInTheDocument();
  });

  it("drops the ceiling for an account that has none", () => {
    usage = { ...usage, plan: "PREMIUM", minutesUsed: 21, minutesLimit: -1 };

    render(<PlanUsage />);

    // No plan is unlimited any more — the allowance is one pair of numbers for
    // every account. -1 is still what the field means, though, and "21 of -1"
    // is the kind of thing that ships if the branch is deleted for being
    // unreachable.
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.queryByText(/of -1/)).not.toBeInTheDocument();
    expect(screen.getByText("Premium")).toBeInTheDocument();
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
