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
    minutesUsed: 47,
    minutesLimit: 100,
    importsUsed: 2,
    importsLimit: 3,
    meetingsUsed: 9,
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
    expect(screen.getByText(/Orion has one plan/i)).toBeInTheDocument();
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

describe("PlansTab, this account", () => {
  it("shows both allowances against what is used", () => {
    render(<PlansTab />);

    expect(screen.getByText("47 of 100")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    // Both are enforced now, so both get a bar. It used to be one, because
    // minutes were tallied and checked against nothing.
    expect(screen.getByRole("progressbar", { name: "Minutes transcribed" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Imports used" })).toBeInTheDocument();
  });

  it("says the allowance does not come back, and that nothing is taken away", () => {
    render(<PlansTab />);

    // The old copy said "Resets on 1 September". There is no reset: this is
    // the account's whole allowance, and somebody told otherwise waits.
    expect(screen.getByText(/not monthly/i)).toBeInTheDocument();
    expect(screen.queryByText(/Resets on/i)).not.toBeInTheDocument();
  });

  it("gives the meeting count as a figure, with no ceiling round it", () => {
    render(<PlansTab />);

    // Nothing refuses a recording for being the tenth. What it costs is its
    // length, and that is the bar above.
    expect(screen.getByText(/9 meetings so far/)).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });

  it("allows an old PREMIUM account exactly what it allows everyone else", () => {
    usage = { ...usage, plan: "PREMIUM" };
    render(<PlansTab />);

    // PREMIUM was unlimited and is a row left by an earlier build. Leaving it
    // uncapped meant the account doing the most work was the one no limit
    // applied to, which is the opposite of what a rate limit is for.
    expect(screen.getByText("47 of 100")).toBeInTheDocument();
    expect(screen.queryByText(/-1/)).not.toBeInTheDocument();
  });

  it("says nothing about usage until it knows", () => {
    loading = true;
    render(<PlansTab />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("PlansTab, what it includes", () => {
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

    // There was a third: 500 custom vocabulary terms, from
    // `VocabularyService.MAX_TERMS_PER_USER`. That feature is gone, and a
    // plans page is the last place a withdrawn limit should still be quoted.
    expect(screen.getByText("Up to 200.")).toBeInTheDocument();
    expect(screen.getByText(/Up to 2,000 on a single meeting/i)).toBeInTheDocument();
    expect(screen.queryByText(/Up to 500 names/i)).toBeNull();
  });

  it("no longer carries the list of what Orion does not do", () => {
    render(<PlansTab />);

    // Removed deliberately. Asserted rather than just deleted, so the section
    // cannot drift back in unnoticed.
    expect(screen.queryByText("What Orion does not do")).toBeNull();
    expect(screen.queryByText("No meeting bot")).toBeNull();
    expect(screen.queryByText("Nothing to upgrade to")).toBeNull();
  });
});
