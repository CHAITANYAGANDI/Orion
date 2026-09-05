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

    // `getAllBy`, because several of these are named twice on purpose now: the
    // sticky showcase says what a stage does and Included says it again as a
    // capability. Mentioning something in the demonstration and in the list is
    // ordinary; what the test is about is that it is named at all.
    for (const real of [
      /Record in your browser/i,
      /Import audio or video/i,
      /Speakers, separated/i,
      /Action items, decisions and risks/i,
      /Ask one meeting, or all of them/i,
      /A transcript you can correct/i,
      /PDF, Word, Markdown or plain text/i,
    ]) {
      expect(screen.getAllByText(real).length).toBeGreaterThan(0);
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
    //
    // Scoped to the header and the footer, which is where identity lives. A
    // mic glyph elsewhere is not the brand: the product preview draws the
    // application's own Record button, and that button has one.
    const { container } = render(<LandingPage />);

    expect(container.querySelector("header")!.querySelector(".lucide-mic")).toBeNull();
    expect(container.querySelector("footer")!.querySelector(".lucide-mic")).toBeNull();
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

    // Anchored on the group's own <section>, which is what a group is now.
    // `parentElement` broke the moment the list gained a stagger wrapper — a
    // selector reaching through markup rather than through structure.
    const capture = screen.getByRole("heading", { name: "Capture & understand" }).closest("section")!;
    const work = screen.getByRole("heading", { name: "Work with it" }).closest("section")!;

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

/**
 * The moments that were added, and the rule every one of them follows.
 *
 * <p>The page grew from three sections to seven. The risk in that is not
 * layout — it is that a marketing page which needs more to say starts saying
 * things the product cannot do. So each new moment is checked for what it
 * claims, and the forbidden-concept sweep above runs over all of it.
 */
describe("how it works", () => {
  it("is three stages of one recording, in order", () => {
    render(<LandingPage />);

    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Record it, or bring it" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Speakers, separated" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "A brief, and what it asks of you" }),
    ).toBeInTheDocument();
  });

  it("says the live text is the live pass, not the finished transcript", () => {
    // Reverie transcribes from the file after Stop. Letting the live words read
    // as the final transcript would promise a fidelity the pipeline does not
    // offer, and the product itself says so on /record.
    //
    // Asserted on the stage COPY rather than on the window's caption: the
    // window is `aria-hidden` demo art and shows one stage at a time, so a
    // caveat living only in there is one a screen reader never reaches and a
    // scroll position can hide.
    render(<LandingPage />);

    expect(
      screen.getAllByText(/full transcript is written from the recording after you stop/i).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * The centrepiece.
 *
 * <p>Under `prefers-reduced-motion` — which is what jsdom reports, since
 * `matchMedia` is unstubbed and answers false to everything — the sequence
 * renders in its finished state. So these assert the *end* of the
 * demonstration, which is the state a reader with reduced motion sees
 * immediately and every other reader sees after four beats.
 */
describe("the Ask showcase", () => {
  it("leads the page's largest moment", () => {
    render(<LandingPage />);

    expect(screen.getByText("Ask Reverie")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Ask a question\. Get the words it came from\./ }),
    ).toBeInTheDocument();
  });

  it("shows a question, an answer, and the line the answer came from", () => {
    // The whole argument of the section: the answer is checkable. If the cited
    // line stops being rendered, the demonstration still animates and no
    // longer demonstrates anything.
    render(<LandingPage />);

    expect(screen.getByText(/What did we decide about pricing, and who owns/i)).toBeInTheDocument();
    expect(screen.getByText(/You held list pricing and moved the annual discount/i)).toBeInTheDocument();
    expect(screen.getByText("The words behind it")).toBeInTheDocument();
    expect(
      screen.getByText(/Hold the price and move the annual discount to fifteen per cent/i),
    ).toBeInTheDocument();
  });

  it("says the scope can be a meeting, a folder or everything", () => {
    render(<LandingPage />);

    expect(screen.getByText(/or a folder, or everything/i)).toBeInTheDocument();
  });

  it("claims nothing about meaning or similarity", () => {
    // Retrieval is lexical. This is the one section where a similarity score or
    // a "found by meaning" line would be the natural thing to write and the
    // wrong thing to ship.
    const { container } = render(<LandingPage />);

    expect(container.textContent).not.toMatch(/similarity|relevance score|embedding|vector/i);
  });
});

describe("the languages moment", () => {
  it("demonstrates a translated brief rather than quoting a number in a strip", () => {
    render(<LandingPage />);

    expect(screen.getByText("Languages")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Read it in the language you think in\./ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/across eighteen of them/i)).toBeInTheDocument();
  });

  it("says the translation is kept, which is what makes it worth doing twice", () => {
    render(<LandingPage />);

    expect(screen.getByText(/once translated it is kept/i)).toBeInTheDocument();
  });
});

describe("the closing section", () => {
  it("is about what happens to the recording, not a second call to action", () => {
    // The hero already asked. A page that asks again at the bottom did not
    // trust its own middle.
    render(<LandingPage />);

    expect(screen.getByText("Yours")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Create a free account/ })).toHaveLength(1);
  });

  it("states the four things somebody weighing this up actually wants", () => {
    render(<LandingPage />);

    expect(screen.getByText("No training on your meetings")).toBeInTheDocument();
    expect(screen.getByText("Retention you set")).toBeInTheDocument();
    expect(screen.getByText("Delete what you like")).toBeInTheDocument();
    expect(screen.getByText("One plan, no card")).toBeInTheDocument();
  });

  it("does not offer a tier that does not exist", () => {
    const { container } = render(<LandingPage />);

    expect(container.textContent).toMatch(/no team tier/i);
    expect(container.textContent).not.toMatch(/upgrade to|contact sales|per seat|per user/i);
  });
});

/**
 * The motion, and the one thing it must never do.
 *
 * <p>A scroll reveal renders `opacity: 0` into the server HTML. That is
 * acceptable for a reader with JavaScript and unacceptable for one without, so
 * the page carries a `<noscript>` override. This is the only test of the
 * animation itself, because the animation is not the point — the copy being
 * readable regardless is.
 */
describe("motion never hides the page", () => {
  it("carries a noscript override for every revealed section", () => {
    const { container } = render(<LandingPage />);

    const fallback = container.querySelector("noscript");
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toContain("[data-reveal]");
    expect(fallback!.textContent).toContain("opacity:1");
  });

  it("puts every claim in the server-rendered markup", () => {
    // Not behind an interaction, a tab or a hover. A landing page whose copy
    // arrives only after JavaScript is a landing page with no copy for a
    // crawler or for anybody whose JavaScript failed.
    const { container } = render(<LandingPage />);

    for (const claim of [
      "Remember the conversation.",
      "Ask a question. Get the words it came from.",
      "Read it in the language you think in.",
      "Capture & understand",
      "Work with it",
      "No training on your meetings",
    ]) {
      expect(container.textContent).toContain(claim);
    }
  });
});

/**
 * The public page is the one route a stranger pays for before they have decided
 * anything, and Framer Motion is the largest thing on it.
 *
 * <p>`motion.div` statically pulls in every feature the library has, including
 * drag and the layout-projection engine, neither of which this page uses. So
 * the page renders `m` components against a `LazyMotion` provider carrying
 * `domAnimation` only, which took the route from 44.3 kB to 33.7 kB.
 *
 * <p>`LandingMotion` runs `strict`, which throws in development if a full
 * `motion` component appears inside it — but only if that component is
 * rendered, and only in development. This is the half that fails in CI: one
 * `motion.div` added later would quietly put ~11 kB back on the front door and
 * nothing else in the suite would notice.
 */
describe("what the front door costs to load", () => {
  const SOURCES = [
    "reveal.tsx",
    "stage-showcase.tsx",
    "ask-showcase.tsx",
    "language-moment.tsx",
  ];

  it("animates with `m`, never the full `motion` component", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const file of SOURCES) {
      const src = readFileSync(
        resolve(process.cwd(), "components/v2/landing", file),
        "utf8",
      );

      // The import, and every element rendered from it.
      expect(src).not.toMatch(/import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*"framer-motion"/);
      expect(src).not.toMatch(/<motion\./);
    }
  });

  it("asks for `domAnimation` and not `domMax`", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "components/v2/landing/motion-provider.tsx"),
      "utf8",
    );

    // domMax adds drag and layout projection. Nothing on this page drags, and
    // nothing animates layout, so paying for either is the regression.
    expect(src).toContain("domAnimation");
    expect(src).not.toMatch(/\bdomMax\b(?![^\n]*`)/);
  });
});
