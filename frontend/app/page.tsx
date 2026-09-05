import Link from "next/link";
import { BrandMark } from "@/components/v2/brand-mark";
import { Reveal, Stagger } from "@/components/v2/landing/reveal";
import { StageShowcase } from "@/components/v2/landing/stage-showcase";
import { AskShowcase } from "@/components/v2/landing/ask-showcase";
import { LanguageMoment } from "@/components/v2/landing/language-moment";

/**
 * The front door.
 *
 * <h2>The composition, and where it comes from</h2>
 *
 * <p>`design-demo/final/55-landing.html`: the public canvas with its one
 * ambient wash, a 68px nav that does not out-weigh the hero, a centred claim,
 * and then the product itself at full width. What is added on top of that is
 * <b>pacing</b> — five large moments instead of one, each held until the reader
 * arrives at it, and each demonstrating something rather than asserting it.
 *
 * <p>Deliberately <b>not</b> added: cards, gradients, a logo wall,
 * testimonials, an integrations grid, a pricing table, a statistics strip. Half
 * of what makes a competitor's marketing page feel full is social proof and
 * integrations, and Reverie has one plan, no integrations and no named
 * customers — so those sections could only be filled by inventing them. This
 * page is longer because there is more true material, not because there are
 * more containers.
 *
 * <h2>The sequence</h2>
 *
 * <ol>
 *   <li><b>Hero.</b> One claim, two ways in. Not animated: it is above the
 *       fold, and revealing it means the first thing anybody sees is an empty
 *       page.</li>
 *   <li><b>The product.</b> A still preview, immediately, so the page shows
 *       what it is before it explains itself.</li>
 *   <li><b>How it works.</b> One window moving through capture → understand →
 *       read, sticky, while the copy scrolls past it. Three stages of one
 *       recording, not three screenshots of three products.</li>
 *   <li><b>Ask Reverie.</b> The largest moment, and the only one that runs a
 *       sequence: a question typed, an answer arriving, and the citation
 *       resolving into the words it came from.</li>
 *   <li><b>Languages.</b> One line of a brief, in six of the eighteen.</li>
 *   <li><b>Included.</b> Two groups, hairlines, no cards.</li>
 *   <li><b>Yours.</b> The quiet close: no training, retention you set, export,
 *       deletion. Not a second call to action — the hero already asked, and a
 *       page that asks again at the bottom did not trust its own middle.</li>
 * </ol>
 *
 * <h2>Every claim maps to production</h2>
 *
 * <p>No Memory, no Commitment Ledger, no Decision Drift, no Decision History,
 * no semantic search, no YouTube or PDF import, no integrations, no
 * system-audio or tab capture. `app/page.test.tsx` asserts the absence of each,
 * and the reasoning is in `docs/v2-implementation/final-parity-audit.md` §6.
 *
 * <p>This file is a server component. Only the four motion pieces are clients,
 * so the copy is in the served HTML — with a `<noscript>` override below for
 * the one thing that would otherwise depend on JavaScript.
 */

export const metadata = {
  title: "Reverie — remember the conversation",
  description:
    "Reverie turns recordings into a clear record: speakers, transcript, brief, action items, search, and answers grounded in the exact words that were said.",
};

export default function LandingPage() {
  return (
    /*
     * NO `overflow-hidden` here, and that is load-bearing rather than tidy.
     *
     * <p>An ancestor with `overflow: hidden` becomes the scroll container that
     * `position: sticky` measures against — so the sticky product window in the
     * showcase below stopped sticking entirely and sat at the top of its grid
     * cell, scrolling out of view while the copy beside it ran on for three
     * viewports. The section looked like it had lost its illustration.
     *
     * <p>It was here to clip the ambient wash. The wash is `inset-x-0` and
     * cannot overflow sideways on its own, so there was nothing to clip.
     */
    <div className="relative min-h-screen bg-background">
      {/*
       * Scroll reveals render at `opacity: 0` in the server HTML, so without
       * this a reader with JavaScript disabled gets a hero and nothing under
       * it. One rule, and the whole page is legible again.
       */}
      {/* `dangerouslySetInnerHTML` because React does not reliably place element
          children inside a `<noscript>` — the tag's content is parsed as raw
          text, so a nested <style> can end up as nothing at all. This is the
          one place on the page where that API is the correct tool. */}
      <noscript
        dangerouslySetInnerHTML={{
          __html: "<style>[data-reveal]{opacity:1!important;transform:none!important}</style>",
        }}
      />

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

        {/*
         * The rhythm. Roughly a screen of air between moments on a desktop, so
         * each one arrives alone — which is most of what makes a long page read
         * as considered rather than as a list of sections.
         */}
        <main className="space-y-32 pb-32 sm:space-y-40 lg:space-y-48">
          <div className="space-y-14">
            <Hero />
            <Preview />
          </div>

          <StageShowcase />
          <AskShowcase />
          <LanguageMoment />
          <Included />
          <Keeping />
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
              every button is an accent that means nothing." */}
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
    <section className="px-6 pt-[68px] text-center lg:px-8">
      <p className="v2-label text-brand-text">
        Meeting intelligence, without the meeting-tool clutter.
      </p>

      {/* Two lines, and the break is written rather than left to the viewport:
          "Remember the conversation." and "Keep the meaning." are a pair, and a
          reflow that puts "Keep" at the end of the first line breaks the
          rhythm the copy is built on. */}
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

      {/* One quiet line, from the approved hero. Not a statistics strip: this
          is the answer to "what does it cost", read once, under the button it
          qualifies. The numbers are `UsageLimitService.MINUTES_ALLOWANCE` and
          `IMPORT_ALLOWANCE`. */}
      <p className="mt-3.5 text-foot text-ink-4">
        100 minutes and three imports, for the life of the account. No card.
      </p>
    </section>
  );
}

/**
 * The product, immediately, before the page explains itself.
 *
 * <p>Still, and deliberately so: the moving demonstrations come later, and a
 * page whose first visual is already animating gives the reader nothing to
 * settle on. Embedded behind a mask that fades its foot rather than floating as
 * a screenshot with a shadow under it.
 */
function Preview() {
  return (
    <Reveal as="section" className="px-6 lg:px-8" y={20}>
      <div
        aria-hidden
        className="mx-auto max-w-doc overflow-hidden rounded-xl border border-line bg-surface [mask-image:linear-gradient(to_bottom,#000_calc(100%-72px),transparent)]"
      >
        <div className="v2-band flex h-band items-center gap-1 px-3">
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
              preview it cannot, and `overflow-hidden` was cropping the avatar
              off the right edge — a picture of the product with a half-drawn
              control in it. */}
          <span className="hidden h-8 items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-2.5 text-foot text-ink-3 sm:flex">
            Search
          </span>
          <span className="flex h-8 items-center gap-1.5 rounded-full bg-brand-fill pl-2.5 pr-3.5 text-foot font-headline text-white">
            Record
          </span>
          <span className="ml-1.5 hidden h-7 w-7 rounded-full bg-brand-fill/25 sm:block" />
        </div>

        <div className="grid gap-8 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <p className="v2-label">Thursday, 28 August</p>
            <p className="mt-1 text-title-1 font-headline text-ink">Good morning, Priya</p>

            <p className="v2-label mt-6">Recent</p>
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

            <p className="v2-label mt-6">Folders</p>
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
    </Reveal>
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
 * ten true sentences come to read as a comparison table for a comparison
 * nobody is making, and there is one plan.
 *
 * <p>Every line is a capability production has today. The search line in
 * particular is deliberate: `SearchCommand` is lexical, with `when:` `type:`
 * `tag:` and `in:` operators over conversations and transcript mentions, and it
 * does not call `POST /search/semantic`. So it does not say "find a decision
 * without knowing the words".
 */
function Included() {
  return (
    <section className="mx-auto max-w-doc px-6 lg:px-8" aria-labelledby="included">
      <Reveal>
        <p className="v2-label" id="included">
          Included
        </p>
      </Reveal>

      <div className="mt-8 grid gap-x-12 gap-y-12 lg:grid-cols-2">
        {/* Each group is a section of its own, not a styled div. Two reasons:
            a screen reader gets a landmark per group rather than one list of
            ten unrelated capabilities, and the boundary is then a real thing a
            test can anchor on — "a row must not leak from one group into the
            other" needs a container to be true of. */}
        {GROUPS.map((group) => (
          <section key={group.heading} aria-labelledby={group.id}>
            <Reveal>
              <h2 id={group.id} className="text-title-1 font-headline text-ink">
                {group.heading}
              </h2>
            </Reveal>
            <Stagger as="ul" className="mt-4">
              {group.items.map((item) => (
                <li key={item.label} className="border-b border-line py-3.5">
                  <p className="text-body text-ink">{item.label}</p>
                  <p className="mt-1 text-callout leading-[1.5] text-ink-3">{item.detail}</p>
                </li>
              ))}
            </Stagger>
          </section>
        ))}
      </div>
    </section>
  );
}

const GROUPS = [
  {
    id: "capture",
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
    id: "work",
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

/**
 * The quiet close.
 *
 * <p>Not a second call to action. The hero already asked, and a page that asks
 * again at the bottom is a page that did not trust its own middle. What goes
 * here instead is what somebody who has read this far is actually weighing up:
 * what happens to the recording.
 *
 * <p>Every line is checkable. No training is `GeneralTab`'s own statement;
 * retention is `RETENTION_CHOICES`; deletion is `eraseAudio`, `eraseTranscript`
 * and close-account; the formats are `ExportFormat` plus MP3 audio; the
 * allowance is `UsageLimitService`.
 */
function Keeping() {
  return (
    <section className="mx-auto max-w-doc px-6 lg:px-8" aria-labelledby="keeping">
      <div className="max-w-[46ch]">
        <Reveal>
          <p className="v2-label" id="keeping">
            Yours
          </p>
          <h2 className="mt-3 text-title-l font-headline leading-[1.14] tracking-[-0.018em] text-ink">
            It stays yours, and you can take it or end it.
          </h2>
        </Reveal>
      </div>

      <Stagger className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {KEEPING.map((item) => (
          <div key={item.label}>
            <p className="text-body font-headline text-ink">{item.label}</p>
            <p className="mt-1.5 text-callout leading-[1.5] text-ink-3">{item.detail}</p>
          </div>
        ))}
      </Stagger>
    </section>
  );
}

const KEEPING = [
  {
    label: "No training on your meetings",
    detail:
      "Your recordings, transcripts and notes are not used to improve any model, are not reviewed by people here, and are not pooled with anybody else's.",
  },
  {
    label: "Retention you set",
    detail:
      "Choose how long recordings and transcripts are kept. Anything past the window is removed.",
  },
  {
    label: "Delete what you like",
    detail:
      "A recording, a transcript, one meeting, or the whole account — permanently, on the spot.",
  },
  {
    label: "One account, one workspace",
    detail:
      "Nothing is shared into it and nobody else can read it. There is no team tier to be upgraded into.",
  },
  {
    label: "Export in four formats",
    detail: "PDF, Word, Markdown or plain text — and the audio as MP3.",
  },
  {
    label: "One plan, no card",
    detail:
      "100 transcribed minutes and three imports for the life of the account. Nothing expires, and nothing already transcribed is taken away.",
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
