"use client";

/**
 * One action item, everywhere one is shown.
 *
 * The same row appears on the meeting page and in the workspace tracker, and it
 * has to be the same row: an item ticked off in one place and still open in the
 * other is the failure that makes people stop trusting a tracker. The two
 * callers differ only in what they hide — a meeting's own list already knows
 * which meeting it is, and only the tracker offers bulk selection.
 *
 * The detail panel is collapsed by default and its comments are not fetched
 * until it opens. A page of fifty tasks would otherwise be fifty requests for
 * logs nobody has asked to read.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronDown,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
  Trash2,
} from "lucide-react";
import {
  useAddActionItemCommentMutation,
  useDeleteActionItemCommentMutation,
  useDeleteActionItemMutation,
  useGetActionItemCommentsQuery,
  usePatchActionItemMutation,
} from "@/lib/api";
import { dueLabel, dueTone, spokenDeadline } from "@/lib/due";
import { formatDateTime, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ActionItemResponse, TranslatedTask } from "@/lib/types";

export interface ActionItemRowProps {
  item: ActionItemResponse;
  /** Show which meeting it came from — off inside a meeting, which already knows. */
  showMeeting?: boolean;
  /** Offer the bulk-selection checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Play the sentence it came from. Given by the meeting page, which has a
   * player; omitted elsewhere, where the row links to the meeting instead.
   */
  onOpenSource?: (seconds: number) => void;
  /**
   * This task in the language the meeting is being read in.
   *
   * Only the row reads in it. The edit form underneath stays in the original,
   * because that is the text an edit would replace — typing a correction over
   * a translation would save the translation as the task.
   */
  translation?: TranslatedTask;
  rightToLeft?: boolean;
}

export function ActionItemRow({
  item,
  showMeeting = true,
  selectable = false,
  selected = false,
  onSelectedChange,
  onOpenSource,
  translation,
  rightToLeft,
}: ActionItemRowProps) {
  const [open, setOpen] = React.useState(false);
  const [patch, { isLoading: saving }] = usePatchActionItemMutation();
  const done = item.status === "DONE";

  async function update(body: Parameters<typeof patch>[0]["body"], failure = "Couldn't update that action item.") {
    try {
      await patch({ id: item.id, body }).unwrap();
    } catch {
      toast.error(failure);
    }
  }

  // The deadline label is computed from the resolved date, so it stays in the
  // reader's locale either way; only the words that were said are translated.
  const deadline = dueLabel(
    translation?.dueDate ? { ...item, dueDate: translation.dueDate } : item,
  );
  const said = spokenDeadline(item);
  const title = translation?.title ?? item.title;

  return (
    <li className="py-2">
      <div className="flex items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select “${title}”`}
            onChange={(e) => onSelectedChange?.(e.target.checked)}
            className="mt-1.5 h-4 w-4 shrink-0 accent-[hsl(var(--muted-foreground))]"
          />
        )}

        <input
          type="checkbox"
          checked={done}
          disabled={saving}
          aria-label={`Mark “${title}” complete`}
          onChange={(e) => update({ status: e.target.checked ? "DONE" : "OPEN" })}
          className="mt-1.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
        />

        <div className="min-w-0 flex-1">
          <p
            dir={rightToLeft && translation?.translated ? "rtl" : undefined}
            className={cn(
              "font-medium leading-snug",
              // Struck through rather than removed: a finished item is still
              // the answer to "did we ever do that", and a list that empties
              // itself as you work makes the work look like it never happened.
              done && "text-muted-foreground line-through",
            )}
          >
            {title}
          </p>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
            <span className="text-muted-foreground">{item.ownerName || "Unassigned"}</span>
            {deadline && (
              <>
                <Separator />
                <span className={dueTone(item.dueStatus)} title={said ?? undefined}>
                  {deadline}
                </span>
              </>
            )}
            {showMeeting && item.meetingTitle && (
              <>
                <Separator />
                <Link
                  href={`/meetings/${item.meetingId}`}
                  className="text-muted-foreground hover:text-primary hover:underline"
                >
                  {item.meetingTitle}
                </Link>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {item.commentCount > 0 && (
              <>
                <MessageSquare className="h-3.5 w-3.5" />
                {item.commentCount}
              </>
            )}
            <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
            <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
          </Button>
        </div>
      </div>

      {open && (
        <>
          {/* Said once, where it matters: the fields below hold the words the
              meeting was in, not the ones on the row above. */}
          {translation?.translated && (
            <p className="ml-7 mt-2 text-xs text-muted-foreground">
              Editing works on the original wording: “{item.title}”.
            </p>
          )}
          <ActionItemDetails item={item} onOpenSource={onOpenSource} onPatch={update} busy={saving} />
        </>
      )}
    </li>
  );
}

function Separator() {
  return (
    <span className="text-border" aria-hidden>
      ·
    </span>
  );
}

/* ---------------------------- expanded detail ---------------------------- */

function ActionItemDetails({
  item,
  onOpenSource,
  onPatch,
  busy,
}: {
  item: ActionItemResponse;
  onOpenSource?: (seconds: number) => void;
  onPatch: (body: { title?: string; ownerName?: string; dueDate?: string }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = React.useState(item.title);
  const [owner, setOwner] = React.useState(item.ownerName ?? "");
  const [due, setDue] = React.useState(item.dueOn ?? "");
  const [remove, { isLoading: deleting }] = useDeleteActionItemMutation();

  // Re-seed when the row changes underneath — a bulk complete refetches the
  // list, and a half-typed title should not survive onto a different task.
  React.useEffect(() => {
    setTitle(item.title);
    setOwner(item.ownerName ?? "");
    setDue(item.dueOn ?? "");
  }, [item.id, item.title, item.ownerName, item.dueOn]);

  const dirty =
    title.trim() !== item.title ||
    owner.trim() !== (item.ownerName ?? "") ||
    due !== (item.dueOn ?? "");

  async function save() {
    if (!title.trim()) {
      toast.error("An action item needs a title.");
      return;
    }
    await onPatch({
      title: title.trim(),
      ownerName: owner.trim(),
      // Empty clears it. The server distinguishes this from an absent field,
      // which is the only way back from a date the extractor invented.
      dueDate: due,
    });
  }

  async function onDelete() {
    try {
      await remove(item.id).unwrap();
      toast.success("Action item deleted.");
    } catch {
      toast.error("Could not delete that.");
    }
  }

  return (
    <div className="ml-7 mt-2 space-y-4 border-l pl-4">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`title-${item.id}`}>What needs to happen</Label>
          <Input
            id={`title-${item.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`owner-${item.id}`}>Owner</Label>
          <Input
            id={`owner-${item.id}`}
            value={owner}
            placeholder="Unassigned"
            onChange={(e) => setOwner(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`due-${item.id}`}>Due</Label>
          <Input
            id={`due-${item.id}`}
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      </div>

      {/* Only shown once the date is our reading rather than theirs, so the
          original promise is never silently replaced by an interpretation. */}
      {item.dueOn && item.dueDate && item.dueDate !== item.dueOn && (
        <p className="text-xs text-muted-foreground">
          Read from “{item.dueDate}”, said in the meeting.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={busy || !dirty}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
        </Button>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive"
              disabled={deleting}
              onSelect={() => void onDelete()}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete action item
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {item.sourceSentence && (
        <div className="space-y-1">
          <blockquote className="border-l-2 border-highlight/40 pl-3 text-sm italic text-muted-foreground">
            {item.sourceSentence}
          </blockquote>
          <SourceLink item={item} onOpenSource={onOpenSource} />
        </div>
      )}

      <CommentLog itemId={item.id} />
    </div>
  );
}

/**
 * "Play 15:42" — where the sentence was said.
 *
 * Absent when the sentence could not be placed in the recording, which is
 * deliberate: a link that seeks to the wrong moment plays somebody saying
 * something else and reads as the evidence being fabricated.
 */
function SourceLink({
  item,
  onOpenSource,
}: {
  item: ActionItemResponse;
  onOpenSource?: (seconds: number) => void;
}) {
  const at = item.sourceStartSeconds;
  if (at == null) return null;

  const label = (
    <>
      <Play className="h-3 w-3" /> {timecode(at)}
    </>
  );

  if (onOpenSource) {
    return (
      <Button
        variant="link"
        size="sm"
        className="h-auto gap-1 px-0 text-xs"
        onClick={() => onOpenSource(at)}
      >
        {label}
      </Button>
    );
  }
  // No player on this page, so open the meeting at that moment instead.
  return (
    <Link
      href={`/meetings/${item.meetingId}?t=${Math.floor(at)}`}
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {label}
    </Link>
  );
}

/* -------------------------------- comments -------------------------------- */

/**
 * The task's working log.
 *
 * Called notes rather than comments in the copy, because "comment" promises a
 * reply and there is nobody to reply — Orion has one account per workspace.
 * What it is for is the thing a status of OPEN cannot say: waiting on legal,
 * half shipped, blocked until Thursday.
 */
function CommentLog({ itemId }: { itemId: string }) {
  const { data, isLoading } = useGetActionItemCommentsQuery(itemId);
  const [add, { isLoading: adding }] = useAddActionItemCommentMutation();
  const [remove] = useDeleteActionItemCommentMutation();
  const [body, setBody] = React.useState("");

  async function submit() {
    const text = body.trim();
    if (!text) return;
    try {
      await add({ id: itemId, body: text }).unwrap();
      setBody("");
    } catch {
      toast.error("Could not save that note.");
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Notes
      </p>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : data && data.length > 0 ? (
        <ul className="space-y-2">
          {data.map((c) => (
            <li key={c.id} className="group flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap">{c.body}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Delete note"
                className="h-7 px-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void remove({ id: itemId, commentId: c.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Textarea
        rows={2}
        value={body}
        aria-label="Add a note"
        placeholder="Waiting on legal until Thursday…"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter posts. Plain Enter is a newline: a note is prose,
          // and losing a paragraph break to a submit is worse than a slightly
          // harder save.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <Button size="sm" variant="secondary" onClick={submit} disabled={adding || !body.trim()}>
        {adding && <Loader2 className="h-4 w-4 animate-spin" />} Add note
      </Button>
    </div>
  );
}
