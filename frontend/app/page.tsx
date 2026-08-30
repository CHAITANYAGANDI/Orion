import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Download,
  FolderTree,
  Languages,
  ListChecks,
  Mic,
  PencilLine,
  Search,
  Users,
} from "lucide-react";

/**
 * The front door.
 *
 * <h2>The thesis</h2>
 *
 * <p>The hero is a transcript. Not a screenshot of one and not an illustration
 * of one — a real one, typeset in the same two faces the product uses, with the
 * timecodes in the margin where the meeting page puts them. Orion turns speech
 * into a record you can act on, so the page opens by doing that: three lines of
 * a meeting, one of them marked, and the commitment that was pulled out of it
 * sitting underneath with an owner and a date on it.
 *
 * <p>That is the whole argument, made in the product's own material rather than
 * asserted in a headline over a gradient. Everything else on the page is
 * quieter than it on purpose.
 *
 * <h2>Every claim here is one the code makes good on</h2>
 *
 * <p>This page used to promise five meetings a month, share links, and agent
 * follow-ups that would "draft emails, create tasks, schedule meetings and
 * Notion notes". The allowance is 100 minutes and 3 imports and always was;
 * sharing was removed; the agents never existed; and there is no email sender
 * in this codebase at all. A landing page is the one screen read by people with
 * no way to check, which is exactly why it is the one that has to be true.
 *
 * <p>So the numbers below come from `UsageLimitService.MINUTES_ALLOWANCE` and
 * `IMPORT_ALLOWANCE`, and every feature named is one with a route behind it.
 */

/** The allowance, as the server enforces it. */
const FACTS = [
  { figure: "100", unit: "minutes", note: "of transcription, free" },
  { figure: "18", unit: "languages", note: "detected or fixed by you" },
  { figure: "3", unit: "imports", note: "of audio or video you already have" },
];

/** A real sequence, which is why it is numbered. */
const STEPS = [
  {
    title: "Record it, or bring it",
    body: "Capture a meeting in the browser, or import audio or video you already have.",
  },
  {
    title: "Watch it come apart",
    body: "Transcription, then the summary, then the commitments — each appearing as it lands, over a socket.",
  },
  {
    title: "Ask it anything",
    body: "Search every meeting, chat across all of them, and export what you need as PDF, Word, Markdown or text.",
  },
];

const FEATURES = [
  {
    icon: Users,
    title: "Speakers, separated",
    body: "Diarization tells the voices apart and numbers them by who spoke first. Naming them is a rename you make.",
  },
  {
    icon: ListChecks,
    title: "Decisions and commitments",
    body: "Every action item with an owner, a due date and comments — and quotations matched back to the transcript before they are stored.",
  },
  {
    icon: Bot,
    title: "Chat across everything",
    body: "Ask one meeting a question, or ask all of them at once. Answers cite the passages they came from.",
  },
  {
    icon: PencilLine,
    title: "A transcript you can correct",
    body: "Edit the words and the speaker labels. Highlight, bookmark and annotate up to 2,000 moments in a meeting.",
  },
  {
    icon: Search,
    title: "Search that reads",
    body: "Find a phrase, or find the meeting where a decision was made without knowing the words used.",
  },
  {
    icon: Languages,
    title: "Read it in another language",
    body: "The brief, the tasks and the transcript, translated once and kept.",
  },
  {
    icon: FolderTree,
    title: "Folders",
    body: "Group meetings by the work they belong to, then ask questions of the whole folder.",
  },
  {
    icon: Download,
    title: "Yours to take",
    body: "Export a meeting as PDF, Word, Markdown or plain text. Delete a recording, a transcript or the whole account.",
  },
];

/** The hero's meeting. Short, ordinary, and the kind of exchange that produces a task. */
const TURNS = [
  { at: "00:12", who: "Priya", said: "We should get the export work out before the quarter closes." },
  { at: "00:19", who: "Dev", said: "I can take that. Friday?", marked: true },
  { at: "00:24", who: "Priya", said: "Friday works. I will let support know." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main>
        <Hero />
        <Facts />
        <HowItWorks />
        <Features />
        <Closing />
      </main>

      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-primary text-primary-foreground">
            <Mic className="h-3.5 w-3.5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Orion</span>
        </div>
        <nav className="flex items-center gap-1">
          <Link
            href="/sign-in"
            className="rounded-lg px-4 py-2 text-[14px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-lg bg-primary px-4 py-2 text-[14px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pb-24 pt-20 sm:pt-28">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[50vmax] w-[80vmax] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(var(--highlight)/0.09),transparent)]"
      />

      <div className="relative mx-auto max-w-3xl text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Meeting intelligence
        </p>
        {/* Light weight, large, tight. The same face the app sets its body in,
            which is what makes this page read as the front of that product. */}
        <h1 className="mx-auto mt-5 max-w-[16ch] text-[clamp(2.5rem,7vw,4.25rem)] font-light leading-[1.04] tracking-[-0.035em]">
          Everything said. Everything decided.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Orion records or imports a meeting, writes it down with the speakers
          separated, and turns it into a brief you can search, question and act
          on.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/sign-up"
            className="group inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-[15px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Create a free account
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </Link>
          <Link
            href="/sign-in"
            className="inline-flex h-11 items-center justify-center rounded-lg border px-6 text-[15px] transition-colors hover:bg-accent"
          >
            Sign in
          </Link>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground">No card. No trial. No seat count.</p>
      </div>

      <TranscriptDemo />
    </section>
  );
}

/**
 * The signature.
 *
 * <p>A meeting, three lines of it, in the product's own typography: JetBrains
 * Mono holds the timecodes so they do not jitter, IBM Plex Sans carries the
 * speech. One line is marked the way the transcript page marks a passage, and
 * what Orion pulled out of it is underneath with the owner and the date on it.
 *
 * <p>The lines settle in sequence on load — the pace of something being
 * transcribed rather than a decoration. `motion-reduce` stops all of it: the
 * point is legible without any of it moving.
 */
function TranscriptDemo() {
  return (
    <div className="relative mx-auto mt-16 max-w-2xl">
      <div className="rounded-xl border bg-card/60 p-5 shadow-2xl shadow-black/40 backdrop-blur-sm sm:p-7">
        <div className="flex items-center justify-between border-b pb-4">
          <p className="text-[14px] font-medium">Quarterly planning</p>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            2 speakers · 00:31
          </p>
        </div>

        <div className="mt-5 space-y-4">
          {TURNS.map((turn, i) => (
            <div
              key={turn.at}
              style={{ animationDelay: `${150 + i * 220}ms` }}
              className="flex animate-in gap-4 fade-in slide-in-from-bottom-2 fill-mode-backwards duration-500 motion-reduce:animate-none"
            >
              <span className="w-11 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                {turn.at}
              </span>
              <p className="text-left text-[15px] leading-relaxed">
                <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {turn.who}
                </span>
                <span
                  className={
                    turn.marked
                      ? "rounded-[3px] bg-[hsl(var(--highlight)/0.22)] px-1 py-0.5 decoration-clone"
                      : undefined
                  }
                >
                  {turn.said}
                </span>
              </p>
            </div>
          ))}
        </div>

        <div
          style={{ animationDelay: "1050ms" }}
          className="mt-6 animate-in border-t pt-5 fade-in fill-mode-backwards duration-700 motion-reduce:animate-none"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Extracted
          </p>
          <div className="mt-3 flex items-center gap-3 rounded-lg border bg-background/60 px-4 py-3">
            <ListChecks className="h-4 w-4 shrink-0 text-[hsl(var(--highlight))]" aria-hidden />
            <span className="flex-1 text-left text-[14px]">Ship the export work</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Dev · Fri
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Facts() {
  return (
    <section className="border-y bg-card/30">
      <div className="mx-auto grid max-w-5xl grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {FACTS.map((fact) => (
          <div key={fact.unit} className="px-6 py-10 text-center">
            <p className="text-[40px] font-light leading-none tracking-[-0.03em]">
              {fact.figure}
              <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {fact.unit}
              </span>
            </p>
            <p className="mt-3 text-[13.5px] text-muted-foreground">{fact.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        How it works
      </p>
      <h2 className="mt-4 max-w-[18ch] text-[clamp(1.75rem,4vw,2.5rem)] font-light leading-tight tracking-[-0.025em]">
        Three steps, and two of them are Orion&apos;s.
      </h2>

      <ol className="mt-14 grid gap-10 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="border-t pt-5">
            {/* Numbered because this genuinely is an order: nothing can be
                summarised before it is transcribed. */}
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-3 text-[17px] font-medium">{step.title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features() {
  return (
    <section className="border-t">
      <div className="mx-auto max-w-5xl px-6 py-24">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          What you get
        </p>
        <h2 className="mt-4 max-w-[20ch] text-[clamp(1.75rem,4vw,2.5rem)] font-light leading-tight tracking-[-0.025em]">
          One account. All of it.
        </h2>

        <div className="mt-14 grid gap-x-12 gap-y-11 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex gap-4">
              <feature.icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <h3 className="text-[16px] font-medium">{feature.title}</h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted-foreground">
                  {feature.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="border-t">
      <div className="mx-auto max-w-2xl px-6 py-28 text-center">
        <h2 className="text-[clamp(2rem,5vw,3rem)] font-light leading-tight tracking-[-0.03em]">
          Your next meeting is worth keeping.
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[16px] leading-relaxed text-muted-foreground">
          100 minutes of transcription and three imports, for the life of the account.
        </p>
        <Link
          href="/sign-up"
          className="group mt-9 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-[15px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Create a free account
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-muted text-muted-foreground">
            <Mic className="h-2.5 w-2.5" />
          </span>
          <span className="text-[13px] text-muted-foreground">Orion</span>
        </div>
        <div className="flex items-center gap-6 text-[13px] text-muted-foreground">
          <Link href="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link href="/sign-in" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
