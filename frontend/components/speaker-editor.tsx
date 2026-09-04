"use client";

/**
 * Fixing who the speakers are, in one place.
 *
 * Two different repairs live here because they answer two different questions
 * and users reach for them at the same moment — looking at a transcript and
 * seeing the speakers are wrong.
 *
 * **Rename** — "Speaker 2 is Priya." One label, one name. Changes what a
 * speaker is *called* and nothing about who owns which turn.
 *
 * **Merge** — "Speaker 3 is also Priya." Diarization split one voice across two
 * labels, usually across a long pause or a change in mic level, and the
 * transcript now shows her interrupting herself. Renaming cannot repair that:
 * naming both labels "Priya" leaves two canonical speakers wearing one name, so
 * she keeps two colours, two talk-time rows, and — because automatic naming
 * refuses a name two speakers hold — stops being nameable at all. Merge moves
 * ownership, so the second label stops existing.
 *
 * <h2>Why they are in the same panel</h2>
 *
 * The rename form used to be a ghost button in the Talk time header, and the
 * merge did not exist. Both are the answer to one observation, and splitting
 * them across the page meant somebody who found one never learned the other was
 * there.
 *
 * <h2>Merge asks twice</h2>
 *
 * There is no undo. The two labels become one, the boundary between them is not
 * stored, and the only way back is Reprocess meeting — which re-runs the whole
 * pipeline. So the button states plainly what it is about to do, with both
 * names in it, rather than saying "Merge" and hoping the selects were read.
 */

import * as React from "react";
import { Check, Loader2, Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpeakerAvatar } from "@/components/speaker-avatar";
import type { SpeakerStats } from "@/lib/types";

export function SpeakerEditor({
  speakers,
  renaming,
  merging,
  onRename,
  onMerge,
}: {
  /** Everyone in this meeting, with the canonical key a merge needs. */
  speakers: SpeakerStats[];
  renaming?: boolean;
  merging?: boolean;
  /** Only the speakers whose name actually changed. Empty means nothing to do. */
  onRename: (mapping: Record<string, string>) => void;
  onMerge: (fromSpeakerKey: string, intoSpeakerKey: string) => void;
}) {
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [from, setFrom] = React.useState("");
  const [into, setInto] = React.useState("");

  // A merge is expressed in canonical keys, not names: two people in a meeting
  // can both be called Chris, and the key is what survives a rename. A
  // transcript stored before keys existed has none, so merge is not offered
  // rather than offered and broken.
  const mergeable = React.useMemo(
    () => speakers.filter((s) => !!s.speakerKey),
    [speakers],
  );
  const canMerge = mergeable.length >= 2;

  const nameOf = React.useCallback(
    (key: string) => mergeable.find((s) => s.speakerKey === key)?.speaker ?? "",
    [mergeable],
  );

  function submitNames() {
    const mapping: Record<string, string> = {};
    for (const [oldName, next] of Object.entries(draft)) {
      const wanted = next.trim();
      if (wanted && wanted !== oldName) mapping[oldName] = wanted;
    }
    onRename(mapping);
    setDraft({});
  }

  function submitMerge() {
    if (!from || !into || from === into) return;
    onMerge(from, into);
    setFrom("");
    setInto("");
  }

  const busy = !!renaming || !!merging;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Rename
        </h4>
        {speakers.map((sp) => (
          <div key={sp.speakerKey ?? sp.speaker} className="flex items-center gap-2">
            <SpeakerAvatar name={sp.speaker} speakerKey={sp.speakerKey} />
            <span className="w-24 shrink-0 truncate text-sm text-muted-foreground">
              {sp.speaker}
            </span>
            <Input
              className="h-8"
              placeholder="New name"
              aria-label={`New name for ${sp.speaker}`}
              value={draft[sp.speaker] ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [sp.speaker]: e.target.value }))
              }
            />
          </div>
        ))}
        <Button size="sm" onClick={submitNames} disabled={busy}>
          {renaming ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Save names
        </Button>
      </section>

      <section className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Merge
        </h4>
        <p className="text-xs text-muted-foreground">
          If one person was split across two speakers, fold them together. The
          turns keep their times and words — only who they belong to changes.
        </p>

        {!canMerge ? (
          <p className="text-xs text-muted-foreground">
            {mergeable.length < 2 && speakers.length >= 2
              ? "This transcript is too old to merge speakers."
              : "There is only one speaker in this meeting."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Speaker to merge"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value="">Choose a speaker…</option>
                {mergeable.map((s) => (
                  <option key={s.speakerKey} value={s.speakerKey as string}>
                    {s.speaker}
                  </option>
                ))}
              </select>
              <span className="text-sm text-muted-foreground">into</span>
              <select
                aria-label="Merge into"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={into}
                onChange={(e) => setInto(e.target.value)}
              >
                <option value="">Choose a speaker…</option>
                {/* Merging somebody into themselves is a typo, not an
                    operation, so it is not offered. */}
                {mergeable
                  .filter((s) => s.speakerKey !== from)
                  .map((s) => (
                    <option key={s.speakerKey} value={s.speakerKey as string}>
                      {s.speaker}
                    </option>
                  ))}
              </select>
            </div>

            <Button
              size="sm"
              variant="secondary"
              onClick={submitMerge}
              disabled={busy || !from || !into || from === into}
            >
              {merging ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Merge className="h-4 w-4" />
              )}
              {/* Both names in the button. There is no undo, and "Merge" beside
                  two selects somebody may not have re-read is how the wrong
                  pair gets joined. */}
              {from && into
                ? `Merge ${nameOf(from)} into ${nameOf(into)}`
                : "Merge speakers"}
            </Button>

            {from && into && (
              <p className="text-xs text-muted-foreground">
                {nameOf(from)} will no longer appear in this transcript. This
                cannot be undone — reprocessing the meeting is the way back.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
