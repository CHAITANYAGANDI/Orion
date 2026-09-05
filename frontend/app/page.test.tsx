import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingPage from "@/app/page";

/**
 * The front door, and the one screen read by people with no way to check.
 *
 * <h2>Two kinds of test here, and they guard against opposite mistakes</h2>
 *
 * <p><b>Claim rot.</b> This page promised five meetings a month when the
 * allowance was 100 minutes; it advertised share links after sharing was
 * removed; and it offered "agent follow-ups" that would draft emails, create
 * tasks and write Notion notes — none of which ever existed, and one of which
 * cannot, because there is no email sender in this codebase at all. Marketing
 * copy rots differently from code: nothing fails when a feature leaves, so the
 * sentence outlives it. Those tripwires are unchanged below.
 *
 * <p><b>Design drift.</b> The second kind is new. This page had already been
 * rewritten once into an invented marketing layout — a transcript vignette, a
 * statistics strip, a numbered "how it works", an eight-item feature grid and a
 * closing slogan. Every line was true and none of it was the approved V2
 * composition. So the V2 identity is now pinned too: the kicker, both lines of
 * the headline, the two Included groups, the real brand mark, and the three
 * invented headlines named explicitly so they cannot come back.
 */

describe("what it promises", () => {
  it("quotes the allowance the server actually enforces", () => {
    render(<LandingPage />);

    // UsageLimitService.MINUTES_ALLOWANCE and IMPORT_ALLOWANCE.
    expect(
      screen.getByText(/100 minutes and three imports, for the life of the account/i),
    ).toBeInTheDocument();
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

  /**
   * The V2 concepts with no schema behind them.
   *
   * <p>`V14` and `V15` dropped `meeting_decisions`, `decision_links`,
   * `decision_vectors`, `commitments` and `commitment_evidence`. The approved
   * V2 landing artifact sold exactly these — its hero read "when a later
   * meeting reverses a decision or a promise quietly slips, you are the one who
   * is told" — so this is the one page where restoring the artifact verbatim
   * would have been the wrong thing to do.
   */
  it.each([
    ["a commitment ledger", /commitment/i],
    ["a promise journey", /promise journey|promise/i],
    ["decision drift", /decision drift|drift/i],
    ["decision history", /decision history/i],
    ["a reversal watcher", /reverses|reversed|slipped|since last meeting/i],
    ["memory as a product feature", /memory layer|meeting memory/i],
  ])("does not advertise %s", (_label, forbidden) => {
    const { container } = render(<LandingPage />);

    expect(container.textContent).not.toMatch(forbidden);
  });

  it("does not claim search understands meaning, because it does not", () => {
    const { container } = render(<LandingPage />);

    // `SearchCommand` is lexical, with `when:` `type:` `tag:` and `in:` over
    // conversations and transcript mentions. It deliberately does not call
    // `POST /search/semantic`. The page it replaced said "find the meeting
    // where a decision was made without knowing the words used", which is a
    // claim about an endpoint this product does not use.
    expect(container.textContent).not.toMatch(
      /semantic|without knowing the words|by meaning|understands what you mean/i,
    );
    expect(
      screen.getByText(/Search conversations and transcript mentions/i),
    ).toBeInTheDocument();
  });

  it("names only capabilities that have a surface behind them", () => {
    render(<LandingPage />);

    for (const real of [
      /Record in your browser/i,
      /Import audio or video/i,
      /Speakers, separated/i,
      /Action items, decisions and risks/i,
      /Ask one meeting, or all of them/i,
      /A transcript you can correct/i,
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
  });

  it("offers Sign in three times, and every one of them lands", () => {
    // Header, the hero's secondary call to action, and the footer. Three is
    // the count the approved composition produces; asserting it rather than
    // "at least one" is what catches a door quietly closing.
    render(<LandingPage />);

    const signIn = screen.getAllByRole("link", { name: "Sign in" });
    expect(signIn).toHaveLength(3);
    for (const link of signIn) expect(link).toHaveAttribute("href", "/sign-in");
  });

  it("keeps Privacy, which is a route that exists", () => {
    render(<LandingPage />);

    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });

  it("invents no links that go nowhere", () => {
    // The design artifact's public nav carried "How it works" and "Pricing",
    // both `href="#"`. Neither is a route, and there is one plan.
    //
    // Read off the LINKS rather than off the page text, which is the honest
    // scope of the rule: "Pricing sync" is an ordinary name for a meeting and
    // appears in the preview, and a text-wide grep for /pricing/ would forbid
    // demo content in order to forbid a nav item.
    const { container } = render(<LandingPage />);

    expect(container.querySelector('a[href="#"]')).toBeNull();
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    for (const link of links) {
      expect(link).not.toMatch(/pricing|enterprise|careers|terms|how it works/i);
    }
  });
});

/**
 * The approved V2 hero, word for word.
 *
 * <p>Pinned because this is the part that drifted. The previous version's
 * headline — "Everything said. Everything decided." — was a perfectly good
 * slogan somebody wrote instead of using the approved one.
 */
describe("the hero", () => {
  it("leads with the V2 kicker", () => {
    render(<LandingPage />);

    expect(
      screen.getByText("Meeting intelligence, without the meeting-tool clutter."),
    ).toBeInTheDocument();
  });

  it("carries both lines of the V2 headline, in one h1", () => {
    render(<LandingPage />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Remember the conversation.");
    expect(heading).toHaveTextContent("Keep the meaning.");
  });

  it("says what the product does without naming a capability it lacks", () => {
    render(<LandingPage />);

    expect(
      screen.getByText(/Reverie turns recordings into a clear record/i),
    ).toBeInTheDocument();
    // "action items", not "commitments" -- the one functional-language
    // adaptation to the approved copy, because Action Items are the real model.
    expect(screen.getByText(/speakers, transcript, brief, action items/i)).toBeInTheDocument();
  });

  it("puts the primary call to action first, and only one of them is filled", () => {
    render(<LandingPage />);

    const primary = screen.getByRole("link", { name: /Create a free account/ });
    const secondary = screen.getAllByRole("link", { name: "Sign in" })[1];
    expect(primary.compareDocumentPosition(secondary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("the product identity", () => {
  it("uses the Reverie mark rather than a microphone glyph", () => {
    // It was a `<Mic />` in a filled rounded square, which is the generic
    // recorder logo the V2 identity study explicitly rejected -- and it meant
    // the public page and the application wore two different brands.
    const { container } = render(<LandingPage />);

    expect(container.querySelector(".lucide-mic")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Reverie" }).length).toBeGreaterThan(0);
  });

  it("names the product beside the mark, in the header and the footer", () => {
    render(<LandingPage />);

    expect(screen.getAllByText("Reverie").length).toBe(2);
  });
});

/**
 * The section that replaced the invented feature grid.
 *
 * <p>Two conceptual groups, which is how the approved design organised this:
 * what Reverie does to a recording, and what you then do with it.
 */
describe("the Included section", () => {
  it("exists, under its own label", () => {
    render(<LandingPage />);

    expect(screen.getByText("Included")).toBeInTheDocument();
  });

  it("is organised into the two V2 groups", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: "Capture & understand" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work with it" })).toBeInTheDocument();
  });

  it("keeps a capability under the group it belongs to", () => {
    // A row leaking between them would put "export" under capture, which is
    // the sort of thing nobody notices and everybody half-reads.
    render(<LandingPage />);

    const capture = screen.getByRole("heading", { name: "Capture & understand" }).parentElement!;
    const work = screen.getByRole("heading", { name: "Work with it" }).parentElement!;

    expect(capture).toHaveTextContent("Record in your browser");
    expect(capture).not.toHaveTextContent("PDF, Word, Markdown");
    expect(work).toHaveTextContent("Search that jumps");
  });
});

/**
 * The invented composition, named so it cannot come back.
 *
 * <p>Each of these was a headline on the page this replaced. None was a lie;
 * all three were somebody designing a second landing page instead of building
 * the approved one, and that is the failure mode this file now guards.
 */
describe("the invented landing page", () => {
  it.each([
    ["the invented hero headline", /Everything said\. Everything decided\./i],
    ["the invented process section", /Three steps, and two of them are Reverie's/i],
    ["the invented features headline", /One account\. All of it\./i],
    ["the invented closing slogan", /Your next meeting is worth keeping/i],
    ["the statistics strip", /18 LANGUAGES|18 languages/i],
  ])("is gone: %s", (_label, forbidden) => {
    const { container } = render(<LandingPage />);

    expect(container.textContent).not.toMatch(forbidden);
  });
});

/**
 * The preview is a picture, not the product.
 *
 * <p>It shows the band, the three places, a conversation list, folders and an
 * answer — all real — but nothing in it does anything. A landing page with
 * half-working chrome in it teaches people the real thing is also half-working,
 * so it is hidden from the accessibility tree and carries no controls at all.
 */
describe("the product preview", () => {
  it("is present, and offers nothing to press", () => {
    const { container } = render(<LandingPage />);

    const preview = container.querySelector('[aria-hidden="true"].rounded-xl');
    expect(preview).not.toBeNull();
    expect(preview!.querySelectorAll("button, a, input")).toHaveLength(0);
  });

  it("shows the three places the application has, and no fourth", () => {
    const { container } = render(<LandingPage />);

    const preview = container.querySelector('[aria-hidden="true"].rounded-xl')!;
    expect(preview).toHaveTextContent("Now");
    expect(preview).toHaveTextContent("Library");
    expect(preview).toHaveTextContent("Ask");
    // Memory was the fourth destination in the concept and has no schema.
    expect(preview).not.toHaveTextContent(/Memory/i);
  });
});
