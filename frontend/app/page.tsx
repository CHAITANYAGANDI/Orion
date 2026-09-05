import Link from "next/link";
import { BrandMark } from "@/components/v2/brand-mark";

/**
 * The front door.
 *
 * <h2>Restored from the approved V2 landing screen, with one substitution</h2>
 *
 * <p>The composition is `design-demo/final/55-landing.html`: the public canvas
 * with its one ambient wash, a 68px quiet nav, a centred hero, and then — the
 * point of the whole page — the claim demonstrated in the product's own
 * material at large size. Not twelve sections. One claim, then the product.
 *
 * <p>What this replaced was an invented marketing layout: a three-line
 * transcript vignette, a 100/18/3 statistics strip, a numbered "how it works",
 * an eight-item feature grid and a closing slogan. Every line of it was true
 * and none of it was the approved design.
 *
 * <h2>The substitution, and why it is not a reinterpretation</h2>
 *
 * <p>The artifact's hero sells the <b>memory layer</b>: "Your meetings stop
 * being recordings", "then keeps watching", "when a later meeting reverses a
 * decision or a promise quietly slips, you are the one who is told" — and its
 * hero demonstration is a Decision Drift margin note reading "Reverses 12
 * August".
 *
 * <p>None of that exists. `V14` and `V15` dropped `meeting_decisions`,
 * `decision_links`, `decision_vectors`, `commitments` and
 * `commitment_evidence`, and nothing replaced them. A landing page is the one
 * screen read by people with no way to check, which is exactly why it is the
 * last place to claim a capability the code cannot keep.
 *
 * <p>So the hero copy is the V2-safe wording from the correction brief, and the
 * hero demonstration is the product preview it specifies — Now, Library, Ask, a
 * conversation list, folders, a selected conversation and a contextual answer.
 * Every capability shown is one production has. The *composition* — quiet nav,
 * centred claim, one large in-situ demonstration, restrained Included section,
 * hairline footer — is the artifact's.
 *
 * <h2>Nothing here is interactive</h2>
 *
 * <p>The preview is a static picture of the product, not the product. It is
 * marked `aria-hidden` and carries no controls: a landing page with half-working
 * chrome in it teaches people that the real thing is also half-working.
 */

export const metadata = {
  title: "Reverie — remember the conversation",
  description:
    "Reverie turns recordings into a clear record: speakers, transcript, brief, action items, search, and answers grounded in the exact words that were said.",
};

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/*
       * THE ONE ORNAMENT IN THE PRODUCT.
       *
       * V1 had two and used them on most screens. This appears on the public
       * and auth pages only, and it exists for a single reason: a marketing
       * page with no photograph needs somewhere for the eye to land before the
       * type starts. It never appears behind product content.
       */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[60vmax] bg-[radial-gradient(120%_62%_at_50%_-12%,hsl(var(--brand)/0.15),transparent_62%),radial-gradient(80%_40%_at_82%_8%,hsl(var(--success)/0.05),transparent_70%)]"
      />

      <div className="relative">
        <Header />
        <main>
          <Hero />
          <Preview />
          <Included />
        </main>
        <Footer />
      </div>
    </div>
  );
}

/**
 * The public nav: the lockup, and the two ways in.
 *
 * <p>Sixty-eight pixels and no border. It must not be heavier than the hero —
 * this page has one job, and a bar competing with the claim under it is the
 * commonest way a landing page loses that job.
 *
 * <p>The mark is the product's own. It was a `<Mic />` glyph in a filled
 * rounded square, which is the generic recorder logo the V2 identity study
 * explicitly rejected — and it meant the public page and the application were
 * wearing two different brands.
 */
function Header() {
  return (
    <header className="relative z-10">
      <div className="mx-auto flex h-[68px] max-w-doc items-center gap-8 px-6 lg:px-8">
        <Lockup size={19} />
        <nav aria-label="Reverie" className="ml-auto flex items-center gap-6">
          {/* A 36px target, not a 20px line of text. It sits beside a filled
              button of the same height, and a link half its neighbour's height
              is both harder to hit and reads as less of an option than it is. */}
          <Link
            href="/sign-in"
            className="flex h-9 items-center rounded-full px-2 text-body text-ink-3 transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          {/* INK, not the accent.
              The V2 palette's own rule: "the primary button in this product is
              INK — a Save button is not an observation, and an accent spent on
              every button is an accent that means nothing." The approved
              landing follows it, and a brand-filled pill here was me spending
              the accent on the two loudest controls on the page. */}
          <Link
            href="/sign-up"
            className="flex h-9 items-center rounded-full bg-ink px-4 text-body font-headline text-surface transition-opacity duration-press ease-soft hover:opacity-90"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

/**
 * The mark and the word, at 0.92x.
 *
 * <p>The mark is drawn slightly smaller than the type: at parity it out-weighs
 * it — the mark is solid and the type is not — and the lockup reads
 * front-heavy. Found by rendering both, not by calculation. See
 * `design-demo/lib/mark.js`.
 */
function Lockup({ size, muted = false }: { size: number; muted?: boolean }) {
  return (
    <span
      className={muted ? "inline-flex items-center text-ink-3" : "inline-flex items-center text-ink"}
      style={{ gap: Math.max(6, Math.round(size * 0.38)) }}
    >
      <BrandMark size={Math.round(size * 0.92)} title="Reverie" />
      <span
        className="font-headline leading-none"
        style={{ fontSize: size, letterSpacing: "-0.028em" }}
      >
        Reverie
      </span>
    </span>
  );
}

/**
 * One claim, centred, and the two ways in under it.
 *
 * <p>The measures are the artifact's: roughly 20 characters on the headline so
 * it breaks where it is written to break, and 62 on the body. The display step
 * is `--t-display`, which the type scale annotates as "the landing hero, once
 * per product" — this is the once.
 */
function Hero() {
  return (
    <section className="px-6 pb-11 pt-[68px] text-center lg:px-8">
      <p className="v2-label text-brand-text">
        Meeting intelligence, without the meeting-tool clutter.
      </p>

      {/* Two lines, and the break is written rather than left to the viewport:
          "Remember the conversation." and "Keep the meaning." are a pair, and a
          reflow that puts "Keep" at the end of the first line breaks the
          rhythm the copy is built on. `block` rather than a <br>, so it
          collapses to one flow only if the words themselves do not fit. */}
      <h1 className="mx-auto mt-[18px] max-w-[20ch] text-[clamp(1.875rem,7vw,var(--t-display))] font-headline leading-[1.06] tracking-[-0.022em] text-ink">
        <span className="block">Remember the conversation.</span>
        <span className="block">Keep the meaning.</span>
      </h1>

      <p className="mx-auto mt-5 max-w-[62ch] text-[1.0625rem] leading-[1.6] text-ink-2">
        Reverie turns recordings into a clear record: speakers, transcript,
        brief, action items, search, and answers grounded in the exact words
        that were said.
      </p>

      {/* Stacks below `sm`, where two side-by-side buttons are each too narrow
          to read and neither is a comfortable target. */}
      <div className="mt-[30px] flex flex-col items-center justify-center gap-2.5 sm:flex-row">
        <Link
          href="/sign-up"
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-6 text-body font-headline text-surface transition-opacity duration-press ease-soft hover:opacity-90 sm:w-auto"
        >
          Create a free account
          <span aria-hidden>&rarr;</span>
        </Link>
        <Link
          href="/sign-in"
          className="flex h-11 w-full items-center justify-center rounded-full border border-edge px-6 text-body text-ink-2 transition-colors duration-press ease-soft hover:border-edge-hover hover:text-ink sm:w-auto"
        >
          Sign in
        </Link>
      </div>

      {/* One quiet line, from the approved hero. Not the statistics strip that
          replaced it: this is the answer to "what does it cost", read once,
          under the button it qualifies. The numbers are
          `UsageLimitService.MINUTES_ALLOWANCE` and `IMPORT_ALLOWANCE`. */}
      <p className="mt-3.5 text-foot text-ink-4">
        100 minutes and three imports, for the life of the account. No card.
      </p>
    </section>
  );
}

/**
 * The demonstration.
 *
 * <h2>Why this is the largest thing on the page</h2>
 *
 * <p>The approved landing put the product itself under the claim at full size,
 * on the argument that showing it in situ is more convincing than any headline
 * about it. That is the composition being restored; only the content differs,
 * because the artifact demonstrated a margin note about a reversed decision and
 * there is no such thing to demonstrate.
 *
 * <p>What it shows instead is the shape of the product as it is: the band with
 * its three places, the newest conversations, the folders they are filed in,
 * one of them open, and an answer that cites the meeting it came from. Every
 * one of those is a screen somebody can reach after signing up.
 *
 * <p>Embedded rather than floating. The window has no drop shadow and no
 * perspective: it sits on the page behind a mask that fades its foot, so it
 * reads as a glimpse into the product rather than a screenshot pasted onto a
 * marketing page.
 */
function Preview() {
  return (
    <section className="px-6 lg:px-8" aria-label="A preview of Reverie">
      <div
        aria-hidden
        className="mx-auto max-w-doc overflow-hidden rounded-xl border border-line bg-surface [mask-image:linear-gradient(to_bottom,#000_calc(100%-72px),transparent)]"
      >
        {/* The band, as the product draws it: 48px, glass, the mark, three
            places, and the controls at the far end. */}
        <div className="v2-band flex h-band items-center gap-1 pl-3 pr-3">
          <span className="flex h-8 w-8 items-center justify-center text-ink">
            <BrandMark size={18} />
          </span>
          <span className="ml-1 flex items-center">
            <span className="relative flex h-band items-center px-[11px] text-body font-headline text-ink after:absolute after:inset-x-[11px] after:bottom-0 after:h-[2px] after:rounded-t-[1px] after:bg-ink after:content-['']">
              Now
            </span>
            <span className="flex h-band items-center px-[11px] text-body text-ink-3">
              Library
            </span>
            <span className="flex h-band items-center px-[11px] text-body text-ink-3">Ask</span>
          </span>
          <span className="flex-1" />
          {/* The band carries five controls at desktop width. Inside a 342px
              preview it cannot, and `overflow-hidden` was quietly cropping the
              avatar off the right edge — a picture of the product with a
              half-drawn control in it. So the two that are not load-bearing to
              the composition stand down below `sm`, and what is left is the
              mark, the three places and Record. A preview crops on purpose or
              it crops by accident; this one does it on purpose. */}
          <span className="hidden h-8 items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-2.5 text-foot text-ink-3 sm:flex">
            Search
          </span>
          <span className="flex h-8 items-center gap-1.5 rounded-full bg-brand-fill pl-2.5 pr-3.5 text-foot font-headline text-white">
            Record
          </span>
          <span className="ml-1.5 hidden h-7 w-7 rounded-full bg-brand-fill/25 sm:block" />
        </div>

        {/* The page: the list on the left, an answer in the margin — the same
            680 + 400 spread the product is built to. */}
        <div className="grid gap-8 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <p className="v2-label">Thursday, 28 August</p>
            <p className="mt-1 text-title-1 font-headline text-ink">Good morning, Priya</p>

            <p className="mt-6 v2-label">Recent</p>
            <div className="mt-2 space-y-1.5">
              {PREVIEW_ROWS.map((row) => (
                <div
                  key={row.title}
                  className={
                    row.open
                      ? "flex items-baseline gap-3 rounded-md border border-line bg-surface-raised px-3 py-2.5"
                      : "flex items-baseline gap-3 rounded-md px-3 py-2.5"
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{row.title}</span>
                  <span className="tabular shrink-0 font-mono text-cap text-ink-4">
                    {row.length}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-6 v2-label">Folders</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PREVIEW_FOLDERS.map((folder) => (
                <span
                  key={folder.name}
                  className="rounded-full border border-line bg-surface-raised px-2.5 py-1 text-cap text-ink-2"
                >
                  {folder.name}{" "}
                  <span className="tabular font-mono text-ink-4">{folder.count}</span>
                </span>
              ))}
            </div>
          </div>

          {/* The margin, carrying the thing this product is for: an answer, and
              the words it came from. */}
          <div className="min-w-0">
            <p className="v2-label">Ask Product Weekly</p>
            <p className="mt-2 rounded-2xl border border-line bg-surface-raised px-3.5 py-2 text-body text-ink">
              What did we decide about pricing?
            </p>
            <p className="v2-read mt-4">
              You held the price and moved the annual discount to 15%. Dev asked
              for a note on the invoice copy.
            </p>
            <div className="v2-note mt-3">
              <span className="block text-foot font-headline text-ink-2">Product Weekly</span>
              <span className="tabular block font-mono text-cap text-ink-3">12:34</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Static demo content. Ordinary meeting names; nothing from any real account. */
const PREVIEW_ROWS = [
  { title: "Product Weekly", length: "42:07", open: true },
  { title: "Pricing sync", length: "18:22", open: false },
  { title: "Design review", length: "36:14", open: false },
];

const PREVIEW_FOLDERS = [
  { name: "Q4 planning", count: 6 },
  { name: "Hiring", count: 3 },
];

/**
 * What is in it, in two groups.
 *
 * <p>Two conceptual halves rather than a wall of feature cards: what Reverie
 * does to a recording, and what you then do with it. Each line is a line — a
 * hairline between them and nothing else. A bordered card per capability is how
 * eight true sentences come to read as a comparison table for a comparison
 * nobody is making, and there is one plan.
 *
 * <p>Every line is a capability production has today. The search line in
 * particular is deliberate: `SearchCommand` is lexical, with `when:` `type:`
 * `tag:` and `in:` operators over conversations and transcript mentions, and it
 * does not call `POST /search/semantic`. So it does not say "find a decision
 * without knowing the words", which is what the page it replaced claimed.
 */
function Included() {
  return (
    <section className="mx-auto max-w-doc px-6 pb-24 pt-20 lg:px-8" aria-labelledby="included">
      <p className="v2-label" id="included">
        Included
      </p>

      <div className="mt-8 grid gap-x-12 gap-y-12 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.heading}>
            <h2 className="text-title-1 font-headline text-ink">{group.heading}</h2>
            <ul className="mt-4">
              {group.items.map((item) => (
                <li key={item.label} className="border-b border-line py-3.5 last:border-b-0">
                  <p className="text-body text-ink">{item.label}</p>
                  <p className="mt-1 text-callout leading-[1.5] text-ink-3">{item.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const GROUPS = [
  {
    heading: "Capture & understand",
    items: [
      {
        label: "Record in your browser",
        detail:
          "Nothing to install, and nothing joins the call to do it. The recording keeps running while you look something else up.",
      },
      {
        label: "Import audio or video",
        detail: "A file you already have, uploaded straight to private storage.",
      },
      {
        label: "Speakers, separated",
        detail:
          "Diarization tells the voices apart and numbers them by who spoke first. Naming them is a rename you make.",
      },
      {
        label: "A brief you can shape",
        detail:
          "Summary templates for the kind of meeting it was, and a rewrite when the transcript changes.",
      },
      {
        label: "Action items, decisions and risks",
        detail:
          "Each with the sentence it was read out of, playable at the moment it was said.",
      },
    ],
  },
  {
    heading: "Work with it",
    items: [
      {
        label: "Ask one meeting, or all of them",
        detail:
          "Answers cite the passages they came from, and a folder can be the scope.",
      },
      {
        label: "A transcript you can correct",
        detail:
          "Edit the words and the speaker labels. Highlight, bookmark and annotate up to 2,000 moments in a meeting.",
      },
      {
        label: "Search that jumps",
        detail:
          "Search conversations and transcript mentions, then jump to the exact moment.",
      },
      {
        label: "Read it in another language",
        detail: "The brief, the action items and the transcript, kept once translated.",
      },
      {
        label: "Yours to take, and to delete",
        detail:
          "Export as PDF, Word, Markdown or plain text. Delete a recording, a transcript or the whole account.",
      },
    ],
  },
];

/** A hairline, the lockup, and only links that go somewhere. */
function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-doc flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row lg:px-8">
        <Lockup size={14} muted />
        {/* `-mx-2` so the padding that makes these tappable does not push them
            off the footer's own alignment. */}
        <div className="-mx-2 flex items-center text-callout text-ink-3">
          <Link
            href="/privacy"
            className="flex h-9 items-center px-2 transition-colors hover:text-ink"
          >
            Privacy
          </Link>
          <Link
            href="/sign-in"
            className="flex h-9 items-center px-2 transition-colors hover:text-ink"
          >
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
