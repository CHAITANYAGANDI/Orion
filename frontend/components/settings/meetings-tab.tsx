"use client";

/**
 * Meetings — sharing, chat, training, and the two things that change how a
 * recording is heard.
 *
 * Sharing and Chat are both about reach: who can see a meeting once it leaves
 * your account, and how much of the archive the chat is allowed to read. Both
 * are defaults rather than rules — every share link still carries its own four
 * flags and its own expiry, and every meeting still answers about itself on its
 * own page.
 *
 * Feedback and Training has no switch, and the absence is the point: Recallix
 * trains nothing on your meetings, so there is nothing here to turn off. A
 * toggle would imply the opposite.
 *
 * Vocabulary and known speakers are last and are inputs to transcription rather
 * than preferences about it. Neither is retroactive, and the cards say so,
 * because a term added to fix a transcript that is already open will not fix it.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Share2, MessagesSquare, Lightbulb, Mic } from "lucide-react";
import { useGetPreferencesQuery, useUpdatePreferencesMutation } from "@/lib/api";
import { VocabularyCard } from "@/components/vocabulary-card";
import { KnownSpeakersCard } from "@/components/known-speakers-card";
import { settingsError, ToggleRow } from "@/components/settings/shared";
import { SHARE_EXPIRY_CHOICES, CHAT_WINDOW_CHOICES } from "@/lib/meeting-settings";

export function MeetingsTab() {
  return (
    <div className="space-y-10">
      <SharingSection />
      <ChatSection />
      <TrainingSection />
      <TranscriptionSection />
    </div>
  );
}

/**
 * What a new share link is set to.
 *
 * <p>These were constants: summary and action items yes, transcript and
 * recording no, no expiry. Good defaults, and somebody else's opinion — a
 * person who never wants a recording leaving their account should not have to
 * remember to untick it every time.
 */
function SharingSection() {
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  async function save(patch: Record<string, unknown>) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  const p = prefs.data;

  return (
    <section aria-labelledby="sharing-heading" className="space-y-1">
      <h2 id="sharing-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Share2 className="h-4 w-4 text-muted-foreground" /> Sharing
      </h2>
      <p className="pb-2 text-sm text-muted-foreground">
        What a new share link is set to. Every link can still be changed
        individually, and changing these never rewrites a link you have already
        sent.
      </p>

      <div className="border-b py-4">
        <p className="font-medium">What a new link includes</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Anyone holding the link is the same anonymous reader, so what varies is
          content rather than permission.
        </p>
        <div className="mt-3 space-y-3">
          <ToggleRow
            label="Summary"
            checked={p?.shareIncludeSummary ?? true}
            onChange={(v) => void save({ shareIncludeSummary: v })}
          />
          <ToggleRow
            label="Action items"
            checked={p?.shareIncludeActionItems ?? true}
            onChange={(v) => void save({ shareIncludeActionItems: v })}
          />
          <ToggleRow
            label="Full transcript"
            checked={p?.shareIncludeTranscript ?? false}
            onChange={(v) => void save({ shareIncludeTranscript: v })}
          />
          <ToggleRow
            label="Recording"
            checked={p?.shareIncludeAudio ?? false}
            onChange={(v) => void save({ shareIncludeAudio: v })}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          A transcript is every word somebody said and a recording is their
          voice, which is why both start off.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 border-b py-4">
        <div className="min-w-0">
          <p className="font-medium">When a new link expires</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A link nobody remembers sending is the one still working a year
            later.
          </p>
        </div>
        <select
          aria-label="When a new link expires"
          value={p?.shareExpiryDays ?? ""}
          onChange={(e) =>
            void save(
              e.target.value === ""
                ? { shareNeverExpires: true }
                : { shareExpiryDays: Number(e.target.value) },
            )
          }
          className="h-9 shrink-0 rounded-md border bg-background px-3 text-sm"
        >
          {SHARE_EXPIRY_CHOICES.map((c) => (
            <option key={c.label} value={c.days ?? ""}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

/**
 * How much of the archive AI Chat reads.
 *
 * <p>A scope control and not a privacy boundary, and the copy says so: nothing
 * is hidden or deleted, and the meeting's own page still answers about it. The
 * value runs the other way — a workspace with three years of standups answers
 * better when the answer is not competing with a decision reversed eighteen
 * months ago.
 */
function ChatSection() {
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  async function save(patch: Record<string, unknown>) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <section aria-labelledby="chat-heading" className="space-y-1">
      <h2 id="chat-heading" className="flex items-center gap-2 text-lg font-semibold">
        <MessagesSquare className="h-4 w-4 text-muted-foreground" /> Chat
      </h2>
      <p className="pb-2 text-sm text-muted-foreground">
        Settings to control AI Chat in your meetings.
      </p>

      <div className="flex items-center justify-between gap-4 border-b py-4">
        <div className="min-w-0">
          <p className="font-medium">Meeting access</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            How far back AI Chat reads when you ask about your whole workspace.
          </p>
        </div>
        <select
          aria-label="Meeting access"
          value={prefs.data?.chatHistoryDays ?? ""}
          onChange={(e) =>
            void save(
              e.target.value === ""
                ? { chatReadsEverything: true }
                : { chatHistoryDays: Number(e.target.value) },
            )
          }
          className="h-9 shrink-0 rounded-md border bg-background px-3 text-sm"
        >
          {CHAT_WINDOW_CHOICES.map((c) => (
            <option key={c.label} value={c.days ?? ""}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-b py-4 text-sm text-muted-foreground">
        <p>
          Nothing is hidden or deleted by narrowing this — a meeting outside the
          window still opens, still answers questions on its own page, and is
          still found by search. Open action items are always included whatever
          you choose: a task owed since March is still owed.
        </p>
        <p className="mt-2">
          Naming meetings with <strong>Add context</strong>, or asking inside a
          folder, overrides the window. You picked those.
        </p>
      </div>
    </section>
  );
}

/**
 * The section with nothing to switch.
 *
 * <p>Every competitor puts a toggle here, because they have something to ask
 * permission for. Recallix does not train models, so the honest version of this
 * section is a statement of who sees the data on the way to producing your
 * notes — and no switch, because a switch would imply there is a use to opt out
 * of.
 */
function TrainingSection() {
  return (
    <section aria-labelledby="training-heading" className="space-y-1">
      <h2 id="training-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Lightbulb className="h-4 w-4 text-muted-foreground" /> Feedback and Training
      </h2>
      <div className="space-y-2 border-b py-4 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">
            Recallix does not train on your meetings.
          </strong>{" "}
          Your recordings, transcripts and notes are not used to improve any
          model, are not reviewed by people here, and are not pooled with anybody
          else&apos;s.
        </p>
        <p>
          Producing your notes does mean sending the audio to a speech-to-text
          provider and the transcript to a language model, both named on the
          Security tab. There is no switch on this section because there is
          nothing to switch off — a toggle here would imply a use that does not
          happen.
        </p>
        {/* Said here because it changed, and because it is the one part of
            the path that is not "after you press Save". Somebody reading this
            page is entitled to know that a meeting is being sent somewhere
            while it is still happening, not only afterwards. */}
        <p>
          <strong className="text-foreground">
            While you are recording, audio is streamed to that same speech-to-text
            provider as you speak
          </strong>{" "}
          — that is what produces the live text on the recording page. It goes
          from your browser to the provider directly, so the words appear
          without waiting for the meeting to end. The recording itself is still
          transcribed in full afterwards, and that fuller transcript is the one
          that is kept.
        </p>
        <p>
          <Link href="/settings/security" className="text-primary underline-offset-2 hover:underline">
            See exactly what Recallix holds of yours
          </Link>
          , export it, or delete it.
        </p>
      </div>
    </section>
  );
}

/** Vocabulary and known speakers — what Recallix is told before it listens. */
function TranscriptionSection() {
  return (
    <section id="vocabulary" aria-labelledby="transcription-heading" className="space-y-4">
      <div>
        <h2
          id="transcription-heading"
          className="flex items-center gap-2 text-lg font-semibold"
        >
          <Mic className="h-4 w-4 text-muted-foreground" /> Words and speakers
        </h2>
        <p className="text-sm text-muted-foreground">
          What Recallix is told before it listens. Both apply to meetings
          processed from now on — an existing transcript has to be reprocessed to
          pick them up.
        </p>
      </div>
      <VocabularyCard />
      <KnownSpeakersCard />
    </section>
  );
}
