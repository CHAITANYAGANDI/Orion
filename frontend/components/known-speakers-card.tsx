"use client";

import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import {
  useDeleteKnownSpeakerMutation,
  useGetKnownSpeakersQuery,
} from "@/lib/api";
import type { KnownSpeaker } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * The names this user has applied to speakers before.
 *
 * There is no "add" here on purpose: the list is written by renaming a speaker
 * on a transcript, so it reflects names actually in use. A separate address
 * book would need maintaining and would drift from the transcripts within a
 * week. Removal exists because a typo, once saved, would otherwise be suggested
 * forever.
 */
export function KnownSpeakersCard() {
  const speakers = useGetKnownSpeakersQuery();
  const [deleteSpeaker] = useDeleteKnownSpeakerMutation();

  async function remove(speaker: KnownSpeaker) {
    try {
      await deleteSpeaker(speaker.id).unwrap();
      toast.success(`"${speaker.displayName}" removed.`);
    } catch {
      toast.error("Could not remove that name.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Known speakers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Names you have given speakers before. They are offered as suggestions
          when you rename someone on a transcript, so a recurring meeting does not
          have to be relabelled every time.
        </p>

        {speakers.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {!speakers.isLoading && (speakers.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">
            No names yet. Rename a speaker on any transcript and it will be
            remembered here.
          </p>
        )}

        <ul className="space-y-1.5">
          {(speakers.data ?? []).map((speaker) => (
            <li
              key={speaker.id}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="font-medium">{speaker.displayName}</span>
              <span className="text-xs text-muted-foreground">
                used {speaker.timesUsed}×
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Remove ${speaker.displayName}`}
                onClick={() => remove(speaker)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
