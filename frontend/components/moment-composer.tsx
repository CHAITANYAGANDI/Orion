"use client";

/**
 * The two selection actions that need more than a click.
 *
 * Both are dialogs rather than inline forms because the selection they act on
 * is somewhere in a long scrolling transcript, and an inline form would push
 * the very words being annotated off the screen.
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useCreateActionItemMutation, useCreateMomentMutation } from "@/lib/api";
import type { MomentRange } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** What the transcript captured when the selection was made. */
export interface Passage {
  ranges: MomentRange[];
  quote: string;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

function Quoted({ quote }: { quote: string }) {
  if (!quote) return null;
  return (
    <p className="max-h-32 overflow-y-auto rounded-md border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-sm italic">
      “{quote}”
    </p>
  );
}

/* -------------------------------- Note --------------------------------- */
export function NoteDialog({
  meetingId,
  passage,
  onClose,
}: {
  meetingId: string;
  /** Null closes the dialog. */
  passage: Passage | null;
  onClose: () => void;
}) {
  const [create, { isLoading }] = useCreateMomentMutation();
  const [body, setBody] = React.useState("");

  // Reset per passage, so a note abandoned on one sentence does not turn up
  // pre-filled on the next.
  React.useEffect(() => {
    setBody("");
  }, [passage]);

  async function save() {
    if (!passage) return;
    const text = body.trim();
    if (!text) return;
    try {
      await create({
        meetingId,
        body: {
          kind: "NOTE",
          ranges: passage.ranges,
          quote: passage.quote,
          body: text,
          speaker: passage.speaker,
          startSeconds: passage.startSeconds,
          endSeconds: passage.endSeconds,
        },
      }).unwrap();
      onClose();
    } catch {
      toast.error("Could not save that note.");
    }
  }

  return (
    <Dialog open={passage !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a note</DialogTitle>
          <DialogDescription>
            Private to you — Reverie has one account per workspace, so there is
            nobody else on this transcript to notify.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Quoted quote={passage?.quote ?? ""} />
          <Textarea
            autoFocus
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter saves. Plain Enter is a newline: a note is prose,
              // and losing a paragraph break to a submit is worse than a
              // slightly harder save.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="What did you want to remember about this?"
          />
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={isLoading || !body.trim()}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />} Save note
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------- Action item ------------------------------ */

/** Long enough to be a task, short enough not to be a paragraph. */
const TITLE_LIMIT = 140;

/**
 * A selected sentence makes a poor task title — it is what somebody said, not
 * what has to happen. It is offered as the starting point anyway, because
 * editing a sentence down is faster than typing from nothing, and the verbatim
 * line is kept separately as the item's evidence either way.
 */
function titleFrom(quote: string): string {
  const q = quote.trim().replace(/\s+/g, " ");
  return q.length <= TITLE_LIMIT ? q : `${q.slice(0, TITLE_LIMIT).trimEnd()}…`;
}

export function ActionItemDialog({
  meetingId,
  passage,
  onClose,
}: {
  meetingId: string;
  passage: Passage | null;
  onClose: () => void;
}) {
  const [create, { isLoading }] = useCreateActionItemMutation();
  const [title, setTitle] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [due, setDue] = React.useState("");

  React.useEffect(() => {
    setTitle(titleFrom(passage?.quote ?? ""));
    // Whoever was speaking is the likeliest owner of what they just promised.
    setOwner(passage?.speaker ?? "");
    setDue("");
  }, [passage]);

  async function save() {
    if (!passage || !title.trim()) return;
    try {
      await create({
        meetingId,
        body: {
          title: title.trim(),
          ownerName: owner.trim() || undefined,
          dueDate: due || undefined,
          // The verbatim line, kept as evidence exactly as the extractor keeps
          // it, so a hand-added item is as traceable as a generated one.
          sourceSentence: passage.quote || undefined,
          // And where it was said. The selection already knows, so this one
          // does not need matching back to a segment the way an extracted
          // item's sentence does.
          sourceStartSeconds: passage.startSeconds,
        },
      }).unwrap();
      toast.success("Action item added.");
      onClose();
    } catch {
      toast.error("Could not create that action item.");
    }
  }

  return (
    <Dialog open={passage !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an action item</DialogTitle>
          <DialogDescription>
            Goes into this meeting&apos;s action items and the workspace list,
            alongside the ones Reverie extracted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Quoted quote={passage?.quote ?? ""} />
          <div className="space-y-1.5">
            <Label htmlFor="moment-action-title">What needs to happen</Label>
            <Input
              id="moment-action-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Send the pricing deck"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="moment-action-owner">Owner</Label>
              <Input
                id="moment-action-owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="Unassigned"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="moment-action-due">Due</Label>
              <Input
                id="moment-action-due"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={isLoading || !title.trim()}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />} Create
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
