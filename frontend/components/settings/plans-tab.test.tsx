import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UsageResponse } from "@/lib/types";

/**
 * Account Settings → Plans.
 *
 * This tab used to sell two products that do not exist, so most of what is
 * asserted here is absence: no second card, no price, no checkout. Those are
 * easy to reintroduce — a pricing table is the most copy-pasted component on
 * the web — and each one is a promise made on behalf of work nobody has done.
 *
 * The other half is the difference between a limit and a counter. Five meetings
 * a month is enforced and gets a bar; minutes are added up after the fact and
 * checked against nothing, so a bar there would draw a ceiling out of thin air.
 * Both come from `/usage`, so a legacy account on an old unlimited plan must
 * not be told it has five.
 */
let usage: UsageResponse;
let loading: boolean;

vi.mock("@/lib/api", () => ({
  useGetUsageQuery: () => ({ data: loading ? undefined : usage, isLoading: loading }),
}));

import { PlansTab } from "@/components/settings/plans-tab";

beforeEach(() => {
  vi.clearAllMocks();
  loading = false;
  usage = {
    plan: "FREE",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    meetingsUsed: 2,
    meetingsLimit: 5,
    aiMinutesUsed: 47,
    aiMinutesLimit: 60,
  };
});

describe("PlansTab, the plan", () => {
  it("names the plan and what it costs", () => {
    render(<PlansTab />);

    expect(screen.getByRole("heading", { name: "Basic" })).toBeInTheDocument();
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Your current plan")).toBeInTheDocument();
  });

  it("says in the opening line that there is only one", () => {
    render(<PlansTab />);

    // The catch, where the catch usually is — before the feature list rather
    // than after it.
    expect(screen.getByText(/Recallix has one plan/i)).toBeInTheDocument();
  });

  it("offers nothing to buy", () => {
    render(<PlansTab />);

    const controls = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")];
    for (const control of controls) {
      expect(control.textContent ?? "").not.toMatch(/upgrade|buy|checkout|get pro|per month|\$/i);
    }
  });

  it("does not price a tier that does not exist", () => {
    render(<PlansTab />);

    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/user\/month/i)).not.toBeInTheDocument();
  });
});

describe("PlansTab, this month", () => {
  it("shows the meeting allowance against what is used", () => {
    render(<PlansTab />);

    expect(screen.getByText("2 of 5")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Meetings used this month" }),
    ).toBeInTheDocument();
  });

  it("says when the allowance comes back, and that nothing is taken away", () => {
    render(<PlansTab />);

    expect(screen.getByText(/Resets on/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing already processed is\s+removed/i)).toBeInTheDocument();
  });

  it("counts minutes without drawing a ceiling round them", () => {
    render(<PlansTab />);

    expect(screen.getByText("47")).toBeInTheDocument();
    // 60 is on the plan and enforced nowhere: `addAiMinutes` increments and
    // never throws. Rendering it as a limit would be the page inventing one.
    expect(screen.queryByText(/47 of 60/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("does not claim five meetings to an account that has no such limit", () => {
    usage = { ...usage, plan: "PREMIUM", meetingsUsed: 21, meetingsLimit: -1 };
    render(<PlansTab />);

    // A dev account upgraded by the old checkout is still out there with 21
    // meetings on it. "21 of -1" is what ships if nobody tests this.
    expect(screen.getByText("21 used")).toBeInTheDocument();
    expect(screen.queryByText(/-1/)).not.toBeInTheDocument();
    expect(screen.getByText(/carries a/i)).toBeInTheDocument();
  });

  it("says nothing about usage until it knows", () => {
    loading = true;
    render(<PlansTab />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("PlansTab, what it does and does not do", () => {
  it("groups what is included", () => {
    render(<PlansTab />);

    for (const heading of [
      "Transcription",
      "Recording and import",
      "Playback",
      "Working with a meeting",
      "Getting things out",
    ]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
  });

  it("quotes the limits the server actually enforces", () => {
    render(<PlansTab />);

    expect(screen.getByText(/Up to 500 names/i)).toBeInTheDocument();
    expect(screen.getByText("Up to 200.")).toBeInTheDocument();
    expect(screen.getByText(/Up to 2,000 on a single meeting/i)).toBeInTheDocument();
  });

  it("warns that nothing joins your calls", () => {
    render(<PlansTab />);

    // The assumption a reader arrives with, and the one that fails latest —
    // after a meeting they expected to be recorded.
    expect(screen.getByText("No meeting bot")).toBeInTheDocument();
    expect(screen.getByText(/never appears in a participant list/i)).toBeInTheDocument();
  });

  it("is straight about the other three absences", () => {
    render(<PlansTab />);

    expect(screen.getByText("Nothing live")).toBeInTheDocument();
    expect(screen.getByText("No mobile apps")).toBeInTheDocument();
    expect(screen.getByText("One account, not a team")).toBeInTheDocument();
  });

  it("says the absences are not a sales tactic", () => {
    render(<PlansTab />);

    expect(screen.getByText("Nothing to upgrade to")).toBeInTheDocument();
    expect(screen.getByText(/no limit here exists to sell you past it/i)).toBeInTheDocument();
  });

  it("sends somebody asking about their data to the tab that answers it", () => {
    render(<PlansTab />);

    expect(screen.getByRole("link", { name: "Security tab" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
  });
});
