"use client";

/**
 * Adding a task by hand.
 *
 * Until now the only way to record one was to select the sentence it was
 * promised in — which is the best way when there is a sentence, and no way at
 * all when there is not. Plenty of commitments are made in a meeting and land
 * in somebody's head rather than in the transcript, and the extractor cannot
 * find what was never said.
 *
 * Every action item belongs to a meeting, and this does not change that. From
 * the tracker the meeting is a choice; from a meeting page it is already
 * settled. That constraint is deliberate — an item with no meeting behind it is
 * a task in a to-do app, and Orion has nothing to say about it: no source
 * sentence, no recording to seek to, nothing for the chat to read.
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { useCreateActionItemMutation, useGetMeetingsQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function NewActionItemDialog({
  meetingId,
  label = "Add action item",
}: {
  /** Fixed when opened from a meeting; chosen in the dialog when absent. */
  meetingId?: string;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [create, { isLoading }] = useCreateActionItemMutation();

  const [title, setTitle] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [due, setDue] = React.useState("");
  const [meeting, setMeeting] = React.useState("");

  // Only fetched when the dialog has to ask — the meeting page already knows.
  const meetings = useGetMeetingsQuery({ size: 100, status: "READY" }, { skip: !!meetingId || !open });

  React.useEffect(() => {
    if (!open) return;
    setTitle("");
    setOwner("");
    setDue("");
    setMeeting("");
  }, [open]);

  const target = meetingId ?? meeting;

  async function save() {
    if (!title.trim() || !target) return;
    try {
      await create({
        meetingId: target,
        body: {
          title: title.trim(),
          ownerName: owner.trim() || undefined,
          dueDate: due || undefined,
        },
      }).unwrap();
      toast.success("Action item added.");
      setOpen(false);
    } catch {
      toast.error("Could not create that action item.");
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an action item</DialogTitle>
            <DialogDescription>
              Goes in alongside the ones Orion extracted, and is kept when the
              meeting is reprocessed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-action-title">What needs to happen</Label>
              <Input
                id="new-action-title"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Send the pricing deck"
              />
            </div>

            {!meetingId && (
              <div className="space-y-1.5">
                <Label htmlFor="new-action-meeting">Meeting</Label>
                <select
                  id="new-action-meeting"
                  value={meeting}
                  onChange={(e) => setMeeting(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Choose a meeting…</option>
                  {(meetings.data?.content ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="new-action-owner">Owner</Label>
                <Input
                  id="new-action-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="Unassigned"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-action-due">Due</Label>
                <Input
                  id="new-action-due"
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={isLoading || !title.trim() || !target}>
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />} Create
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
