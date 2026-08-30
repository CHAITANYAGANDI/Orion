import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingPage from "@/app/page";

/**
 * The front door, and the one screen read by people with no way to check.
 *
 * <h2>Why most of this file is about claims rather than layout</h2>
 *
 * <p>This page promised five meetings a month when the allowance was 100
 * minutes; it advertised share links after sharing was removed; and it offered
 * "agent follow-ups" that would draft emails, create tasks and write Notion
 * notes — none of which ever existed, and one of which cannot, because there is
 * no email sender in this codebase at all.
 *
 * <p>Marketing copy rots differently from code: nothing fails when a feature
 * leaves, so the sentence outlives it. These are the tripwires. Each one names
 * something that has actually been removed from this product, so re-adding the
 * claim breaks a test rather than a promise.
 */

describe("what it promises", () => {
  it("quotes the allowance the server actually enforces", () => {
    render(<LandingPage />);

    // UsageLimitService.MINUTES_ALLOWANCE and IMPORT_ALLOWANCE.
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getByText(/minutes of transcription and three imports/i)).toBeInTheDocument();
  });

  it("does not sell a meeting quota, which is not how the limit works", () => {
    const { container } = render(<LandingPage />);

    // "Five meetings a month" was on this page for months. The limit is
    // minutes, once, for the life of the account.
    expect(container.textContent).not.toMatch(/meetings a month|per month|monthly/i);
  });

  it.each([
    ["sharing, which was removed", /share link|shareable|share a meeting/i],
    ["email, which has no sender in this codebase", /email recap|daily digest|draft email/i],
    ["Notion and agent follow-ups, which never existed", /notion|agent follow|schedule meetings/i],
    ["a calendar, which was removed", /calendar|ical/i],
  ])("does not advertise %s", (_label, forbidden) => {
    const { container } = render(<LandingPage />);

    expect(container.textContent).not.toMatch(forbidden);
  });

  it("names only features that have a route behind them", () => {
    render(<LandingPage />);

    for (const real of [
      /speakers, separated/i,
      /decisions and commitments/i,
      /chat across everything/i,
      /PDF, Word, Markdown or plain text/i,
    ]) {
      expect(screen.getByText(real)).toBeInTheDocument();
    }
  });
});

describe("the way in", () => {
  it("offers the two doors, twice over", () => {
    render(<LandingPage />);

    const signUp = screen.getAllByRole("link", { name: /Create a free account|Get started/ });
    expect(signUp.length).toBeGreaterThanOrEqual(2);
    for (const link of signUp) expect(link).toHaveAttribute("href", "/sign-up");

    expect(screen.getAllByRole("link", { name: "Sign in" })[0]).toHaveAttribute("href", "/sign-in");
  });

  it("says what signing up costs, which is nothing", () => {
    render(<LandingPage />);

    expect(screen.getByText(/No card\. No trial\./i)).toBeInTheDocument();
  });
});

describe("the hero", () => {
  it("is the product's own artifact rather than a description of one", () => {
    // A transcript: timecodes, two speakers, and the commitment pulled out of
    // it. The argument is made in the material rather than asserted.
    render(<LandingPage />);

    expect(screen.getByText("00:19")).toBeInTheDocument();
    expect(screen.getAllByText("Priya").length).toBe(2);
    expect(screen.getByText("Ship the export work")).toBeInTheDocument();
    expect(screen.getByText("Dev · Fri")).toBeInTheDocument();
  });

  it("holds its heading to one clear claim", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: /Everything said\. Everything decided\./ }),
    ).toBeInTheDocument();
  });
});
