"use client";

/**
 * What each area of a meeting says while its own data does not exist yet.
 *
 * <p>All four are **temporary and additive**. None of them renders once the
 * meeting is READY: the finished page is the same components it always was, and
 * nothing here is a second, permanent state for a completed meeting.
 *
 * <p>They exist because of what the page said before. A meeting still being
 * transcribed showed "No summary available" and an empty transcript — sentences
 * about a *finished* meeting that turned out to have nothing in it. That is not
 * merely unhelpful, it is a wrong answer given confidently, which is exactly
 * what this codebase refuses to do everywhere else. A pending result and an
 * empty result are different facts and now read differently.
 */

import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** A brief that is coming, drawn as the shape it will have. */
export function ProcessingSummary({ stage }: { stage: "waiting" | "generating" }) {
  return (
    <div className="space-y-3" aria-busy>
      {/* The shape of a summary, so the space does not collapse and then jump
          when the real one lands. `Skeleton` carries the project's own pulse,
          which is where `prefers-reduced-motion` is already handled. */}
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <p className="pt-1 text-callout text-ink-3">
        {stage === "waiting" ? (
          <>
            <span className="font-headline text-ink">
              Summary is waiting for the transcript.
            </span>{" "}
            We&rsquo;ll generate it once transcription finishes.
          </>
        ) : (
          <>
            <span className="font-headline text-ink">Generating summary…</span> The
            transcript is ready and can be read now.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * A transcript that is coming.
 *
 * <p>Deliberately not an empty `TranscriptPanel`. A transcript with no lines in
 * it looks like a recording that captured nothing, which is the one conclusion
 * that must not be drawn from a meeting still being transcribed.
 */
export function ProcessingTranscript() {
  return (
    <Card>
      <CardContent className="space-y-3 pt-6" aria-busy>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-11/12" />
        <p className="pt-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Transcript is being prepared…</span>{" "}
          It will appear here as soon as transcription finishes.
        </p>
      </CardContent>
    </Card>
  );
}

/** Action items that have not been extracted yet. */
export function ProcessingActionItems({ ready }: { ready: boolean }) {
  return (
    <div className="space-y-3" aria-busy>
      {/* Checklist-shaped, matching the rows that will replace them. */}
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
      <p className="text-sm text-muted-foreground">
        {ready ? (
          <>
            <span className="font-medium text-foreground">Extracting action items…</span> This
            may take a moment.
          </>
        ) : (
          "Action items will be extracted after the transcript is ready."
        )}
      </p>
    </div>
  );
}

/**
 * The chat rail, before there is anything for it to answer from.
 *
 * <p>Not a disabled composer. A box you can type into that cannot answer is
 * worse than no box: it invites the question and then loses it.
 */
export function ProcessingChatRail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">AI Chat will be available once the transcript is ready.</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        It answers from this meeting&rsquo;s transcript, so there is nothing for it to read yet.
      </p>
    </div>
  );
}
