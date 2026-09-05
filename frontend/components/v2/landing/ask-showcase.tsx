"use client";

/**
 * ASK REVERIE — the strongest moment on the page.
 *
 * <h2>Why this one is demonstrated rather than described</h2>
 *
 * <p>Every competitor can show you a transcript. What is worth the largest
 * moment on this page is the thing that is hard: a question in ordinary
 * language, an answer, and — the part that matters — the exact words the answer
 * came from, playable. A sentence claiming "answers cite their sources" asks to
 * be believed. Watching a citation resolve into the line that was actually said
 * does not.
 *
 * <p>So the sequence runs once, when the reader arrives, in the order the
 * product runs it: the question is typed, the answer arrives, the citation
 * appears, and then the transcript underneath scrolls to the cited line and
 * lights the words. Four beats, and the fourth is the argument.
 *
 * <h2>What is real here</h2>
 *
 * <p>All of it, structurally. `useWorkspaceChat` and the meeting chat both take
 * a question, return an answer, and return citations carrying a `meetingId`
 * and a `start` second; `SourceList` renders them as a margin note; clicking one
 * opens the meeting at that moment. The scope chip is real — a meeting, a
 * folder, or the whole workspace. The question, the answer and the transcript
 * are invented, because a marketing page cannot use anybody's real meeting.
 *
 * <p>What is <b>not</b> here, deliberately: no similarity score, no "found by
 * meaning", no embedding language. Retrieval is lexical and
 * `POST /search/semantic` is unused.
 */

import * as React from "react";
import { m, useInView } from "framer-motion";
import { AtSign, Quote } from "lucide-react";
import { LANDING_EASE, useMotionAllowed } from "@/components/v2/landing/reveal";
import { cn } from "@/lib/utils";

const QUESTION = "What did we decide about pricing, and who owns the follow-up?";

const ANSWER =
  "You held list pricing and moved the annual discount to 15%. Dev owns the invoice copy and raised proration as a second change that has to land with it.";

/** The line the citation resolves to, and the two around it for context. */
const TRANSCRIPT = [
  { who: "Priya", at: "12:28", text: "So we are agreed we are not touching list.", cited: false },
  {
    who: "Dev",
    at: "12:34",
    text: "Hold the price and move the annual discount to fifteen per cent instead.",
    cited: true,
  },
  { who: "Priya", at: "12:41", text: "Then can you note the invoice copy?", cited: false },
];

/** Which beat of the sequence is running. */
type Beat = "idle" | "typing" | "thinking" | "answering" | "citing" | "settled";

export function AskShowcase() {
  const moving = useMotionAllowed();
  const root = React.useRef<HTMLDivElement>(null);
  /* `once` so scrolling back up does not replay it. A demonstration that
     restarts every time it is passed is a demonstration nobody finishes. */
  const seen = useInView(root, { once: true, margin: "0px 0px -25% 0px" });
  const beat = useSequence(seen && moving, moving);

  const typed = useTyped(QUESTION, beat === "typing", moving, 26);

  return (
    <section
      ref={root}
      aria-labelledby="ask"
      className="mx-auto max-w-doc px-6 lg:px-8"
    >
      <div className="max-w-[46ch]">
        <p className="v2-label text-brand-text" id="ask">
          Ask Reverie
        </p>
        <h2 className="mt-3 text-title-l font-headline leading-[1.14] tracking-[-0.018em] text-ink">
          Ask a question. Get the words it came from.
        </h2>
        <p className="mt-4 text-[1.0625rem] leading-[1.6] text-ink-2">
          Ask one meeting, a folder, or everything you have. Every answer carries
          the passages behind it, and each one plays the moment it was said — so
          you can check it rather than trust it.
        </p>
      </div>

      {/* The demonstration. Not a card: a rule down the left, the same device
          the product uses for evidence, and nothing else around it. */}
      <div aria-hidden className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:gap-14">
        <div className="min-w-0">
          {/* The composer, with the scope it is asking within. */}
          <div className="rounded-xl border border-edge bg-surface-raised">
            <div className="flex items-center gap-1.5 px-3.5 pt-3">
              <span className="flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 px-2.5 py-1 text-cap font-medium text-brand-text">
                <AtSign className="h-3 w-3" />
                Product Weekly
              </span>
              <span className="text-cap text-ink-4">or a folder, or everything</span>
            </div>
            <p className="min-h-[3.25rem] px-3.5 py-3 text-body text-ink">
              {moving ? typed : QUESTION}
              {beat === "typing" && (
                <span className="ml-px inline-block h-[1.05em] w-[1.5px] translate-y-[0.15em] animate-recpulse bg-brand-text align-baseline" />
              )}
            </p>
          </div>

          {/* The answer. Serif, because an answer is something you read and
              quote from — the same face a transcript and a brief are set in. */}
          <div className="mt-7 min-h-[8.5rem]">
            {beat === "thinking" && <Thinking />}
            {(beat === "answering" || beat === "citing" || beat === "settled") && (
              <Answer text={ANSWER} animate={moving && beat === "answering"} />
            )}

            {(beat === "citing" || beat === "settled") && (
              <m.div
                initial={moving ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: LANDING_EASE }}
                className="v2-note mt-5"
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-foot font-headline text-ink-2">Product Weekly</span>
                  <span className="tabular inline-flex items-center gap-1 font-mono text-cap text-brand-text">
                    <Quote className="h-3 w-3" /> 12:34
                  </span>
                </span>
              </m.div>
            )}
          </div>
        </div>

        {/* Where the citation lands. This is the fourth beat and the whole
            argument: the answer is checkable. */}
        <div className="min-w-0">
          <p className="v2-label">The words behind it</p>
          <div className="mt-3 space-y-4">
            {TRANSCRIPT.map((line) => {
              const lit = line.cited && (beat === "citing" || beat === "settled");
              return (
                <m.div
                  key={line.at}
                  animate={
                    moving
                      ? { opacity: lit ? 1 : line.cited ? 1 : beat === "settled" ? 0.4 : 0.55 }
                      : undefined
                  }
                  transition={{ duration: 0.5, ease: LANDING_EASE }}
                >
                  <span className="text-cap text-ink-4">
                    {line.who} <span className="text-ink-5">·</span>{" "}
                    <span className="tabular font-mono">{line.at}</span>
                  </span>
                  {/* The highlight hugs the words rather than filling the
                      column. A block tint reads as a selection somebody dragged;
                      the product tints the words themselves, and this is meant
                      to look like the product. `box-decoration-break: clone` is
                      what carries the padding and the radius onto the second
                      line instead of leaving one long unbroken bar. */}
                  <p className="v2-read mt-0.5">
                    <span
                      className={cn(
                        "box-decoration-clone rounded px-1 transition-colors duration-500",
                        lit ? "bg-brand/25 text-ink" : "bg-transparent",
                      )}
                    >
                      {line.text}
                    </span>
                  </p>
                </m.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The answer, arriving.
 *
 * <p>By word rather than by character. A per-character reveal reads as a
 * teleprinter and invites the reader to watch the letters instead of the
 * sentence; by word it reads the way the product's own streamed answers do.
 */
function Answer({ text, animate }: { text: string; animate: boolean }) {
  const words = React.useMemo(() => text.split(" "), [text]);
  // 11ms rather than the question's 26: this is six times the length, and at
  // the same rate it would still be arriving after the citation had landed.
  const shown = useTyped(text, animate, animate, 11);
  const upto = animate ? shown.split(" ").length : words.length;

  return (
    <p className="v2-read">
      {words.slice(0, upto).join(" ")}
    </p>
  );
}

/** Reverie working. Three dots, the product's own breathe, and no spinner. */
function Thinking() {
  return (
    <span className="flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-breathe rounded-full bg-ink-4"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
      <span className="ml-1.5 text-callout text-ink-4">Reading the meeting…</span>
    </span>
  );
}

/* ------------------------------ the sequence ------------------------------ */

/**
 * The four beats, once, when the reader arrives.
 *
 * <p>Every timer is cleared on unmount and none is started unless motion is
 * allowed — under `prefers-reduced-motion` the sequence jumps straight to
 * `settled`, which is the finished state with everything visible. That is the
 * rule the whole page follows: reduced motion means the absence of motion, not
 * a faster version of it.
 */
function useSequence(start: boolean, moving: boolean): Beat {
  const [beat, setBeat] = React.useState<Beat>(moving ? "idle" : "settled");

  React.useEffect(() => {
    if (!moving) {
      setBeat("settled");
      return;
    }
    if (!start) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, next: Beat) => timers.push(setTimeout(() => setBeat(next), ms));

    /*
     * Four beats in about five seconds, not eight.
     *
     * <p>The first cut ran 7.6s and it was too slow to be a demonstration: a
     * reader arriving, seeing "Reading the meeting…", and scrolling on has been
     * shown a loading state rather than an answer. The sequence has to finish
     * inside the time somebody is willing to look at one section.
     */
    setBeat("typing");
    at(1800, "thinking");
    at(2500, "answering");
    at(4400, "citing");
    at(5200, "settled");

    return () => timers.forEach(clearTimeout);
  }, [start, moving]);

  return beat;
}

/**
 * Text revealing itself, one step per tick.
 *
 * <p>Returns the whole string immediately when it is not running, so a caller
 * never has to hold two branches for "animating" and "done".
 */
function useTyped(text: string, running: boolean, moving: boolean, stepMs = 34): string {
  const [n, setN] = React.useState(0);

  React.useEffect(() => {
    if (!moving || !running) return;
    setN(0);
    const id = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(id);
          return v;
        }
        return v + 1;
      });
    }, stepMs);
    return () => clearInterval(id);
  }, [text, running, moving, stepMs]);

  if (!moving) return text;
  if (!running) return n === 0 ? "" : text;
  return text.slice(0, n);
}
