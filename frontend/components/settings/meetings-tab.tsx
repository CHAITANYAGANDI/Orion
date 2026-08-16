"use client";

/**
 * Meetings — the two things that change how a recording is heard.
 *
 * Both are inputs to transcription rather than preferences about it, which is
 * why they live together and away from everything else. Custom vocabulary is
 * sent with the transcription job, so it applies to meetings processed after it
 * is added and an existing transcript has to be reprocessed to benefit. Known
 * speakers are what turn "Speaker 1" into a name across calls.
 *
 * Neither is retroactive, and the cards say so, because a term added to fix a
 * transcript that is already open will not fix it.
 */

import { Mic } from "lucide-react";
import { VocabularyCard } from "@/components/vocabulary-card";
import { KnownSpeakersCard } from "@/components/known-speakers-card";

export function MeetingsTab() {
  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Mic className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          What Recallix is told before it listens. Both apply to meetings
          processed from now on — an existing transcript has to be reprocessed to
          pick them up.
        </span>
      </p>
      <VocabularyCard />
      <KnownSpeakersCard />
    </div>
  );
}
