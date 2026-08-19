"use client";

/**
 * Everything you can do to a processed meeting, in one menu.
 *
 * <p>These were scattered: filing was a select under the title, re-transcribing
 * was a button in the masthead, erasure hid inside a menu called Export, and
 * fixing the speakers was a control you could only find by scrolling into the
 * transcript and hovering. That is not a set of choices, it is a set of places
 * to remember — and the two most consequential things on it (re-transcribe,
 * delete) were the two sitting loose in the header where they could be hit
 * while reaching for something else.
 *
 * <p>Ordered by what it costs to be wrong. Copying is free and reversible,
 * filing is one click to undo, regenerating spends a model call and rewrites
 * the brief, re-transcribing throws away every correction anybody made, and
 * deleting the meeting is last so nothing lands there by momentum. The
 * separators are where the cost changes.
 *
 * <p>Deleting the recording and deleting the transcript used to sit above it,
 * as their own grains. They are gone from the menu; only the whole meeting can
 * be deleted here now. The endpoints behind them are untouched and the nightly
 * retention pass still calls them, so a meeting can still arrive on the page
 * with its audio already erased — which is why the page keeps the line saying
 * when that happened.
 *
 * <p>One operation opens a dialog and owns its own state here, because it is
 * self-contained given a meeting id: choosing a project. The rest are callbacks
 * — their data (the summary, the segments, the erasure timestamps, the language
 * being read in) lives on the page.
 *
 * <p>What is deliberately not here: telling the transcriber it heard the wrong
 * language. That was "Change language…", it re-transcribed from the audio, and
 * it sat one menu away from a picker that translated — two controls saying
 * "language", one of which quietly destroyed hand corrections. It was removed
 * rather than renamed. POST /meetings/:id/language still works and nothing in
 * the app calls it; "Transcribe again" below re-runs the pipeline with the
 * language the meeting already has.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  FolderInput,
  Languages,
  Link2,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import {
  useAssignProjectMutation,
  useGetLanguagesQuery,
  useGetProjectsQuery,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface MeetingMenuProps {
  meetingId: string;
  /** Where it is filed now, so Move can show the current answer as chosen. */
  projectId?: string | null;
  /** There is a transcript to copy, and speakers in it worth rematching. */
  hasTranscript: boolean;
  /** There is a summary to copy or rewrite. */
  hasSummary: boolean;
  /**
   * There is something worth reading in another language.
   *
   * The dialog lives on the page, like the export one and for the same reason:
   * the language being read in decides what the whole page renders, so the page
   * has to own it.
   */
  canTranslate: boolean;
  /** There is a source to run the pipeline over again. */
  canReprocess: boolean;

  onCopySummary: () => void;
  onCopyTranscript: () => void;
  onRegenerateSummary: () => void;
  onTranslate: () => void;
  onRematchSpeakers: () => void;
  onReprocess: () => void;
  onDelete: () => void;

  /** Greys the whole menu while something it started is in flight. */
  busy?: boolean;
}

export function MeetingMenu(props: MeetingMenuProps) {
  const [moving, setMoving] = React.useState(false);

  async function copyLink() {
    // The in-app URL, not a share link. Minting a public capability URL from a
    // menu item called "Copy link" would publish a meeting nobody asked to
    // publish — that lives behind Share, which says what it is giving away.
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/meetings/${props.meetingId}`);
      toast.success("Link copied. It opens for you, not for anyone else.");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions" disabled={props.busy}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => setMoving(true)}>
            <FolderInput /> Move…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyLink()}>
            <Link2 /> Copy link
          </DropdownMenuItem>
          {props.canTranslate && (
            <DropdownMenuItem onSelect={props.onTranslate}>
              <Languages /> Read in another language…
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {props.hasSummary && (
            <>
              <DropdownMenuItem onSelect={props.onCopySummary}>Copy summary</DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onRegenerateSummary}>
                <Sparkles /> Regenerate summary
              </DropdownMenuItem>
            </>
          )}
          {props.hasTranscript && (
            <DropdownMenuItem onSelect={props.onCopyTranscript}>Copy transcript</DropdownMenuItem>
          )}

          {(props.hasTranscript || props.canReprocess) && <DropdownMenuSeparator />}

          {props.hasTranscript && (
            <DropdownMenuItem onSelect={props.onRematchSpeakers}>
              <Users /> Rematch speakers
            </DropdownMenuItem>
          )}
          {props.canReprocess && (
            <DropdownMenuItem onSelect={props.onReprocess}>
              <RefreshCw /> Transcribe again
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={props.onDelete}
          >
            <Trash2 /> Delete this meeting
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MoveDialog
        open={moving}
        onOpenChange={setMoving}
        meetingId={props.meetingId}
        projectId={props.projectId}
      />
    </>
  );
}

/* ------------------------------- Move ---------------------------------- */

/**
 * Filing a meeting into a project.
 *
 * <p>A list rather than the header's dropdown, and that is the point of having
 * both. The select under the title is for changing your mind about a meeting
 * you are reading; this is for the moment you went looking for where it should
 * live, so it shows every project at once with the current one marked, and it
 * has somewhere to say "you have no projects yet" — which the select cannot,
 * because it renders as nothing at all when the list is empty.
 */
function MoveDialog({
  open,
  onOpenChange,
  meetingId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  projectId?: string | null;
}) {
  const { data: projects } = useGetProjectsQuery();
  const [assign, { isLoading }] = useAssignProjectMutation();

  async function move(next: string | null) {
    if ((next ?? null) === (projectId ?? null)) {
      onOpenChange(false);
      return;
    }
    try {
      await assign({ meetingId, projectId: next }).unwrap();
      toast.success(next ? "Moved." : "Moved to Unfiled.");
      onOpenChange(false);
    } catch {
      toast.error("Couldn't move that meeting.");
    }
  }

  const list = projects ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move this meeting</DialogTitle>
          <DialogDescription>
            A project groups meetings and gives them a shared chat. A meeting can
            be in one at a time.
          </DialogDescription>
        </DialogHeader>

        {list.length === 0 ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              You have no projects yet, so there is nowhere to move this to.
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link href="/projects">Create one →</Link>
            </Button>
          </div>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto py-1">
            <Row
              label="Unfiled"
              hint="Stays in All meetings and nowhere else."
              selected={!projectId}
              disabled={isLoading}
              onSelect={() => void move(null)}
            />
            {list.map((p) => (
              <Row
                key={p.id}
                label={p.name}
                hint={
                  p.meetingCount === 1 ? "1 meeting" : `${p.meetingCount} meetings`
                }
                selected={p.id === projectId}
                disabled={isLoading}
                onSelect={() => void move(p.id)}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50",
          selected && "bg-accent",
        )}
      >
        <Check className={cn("h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint && <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
      </button>
    </li>
  );
}
