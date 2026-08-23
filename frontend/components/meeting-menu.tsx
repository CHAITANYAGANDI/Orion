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
 * <p>Nothing is hidden for want of something to act on. An item with no
 * transcript behind it is greyed, not removed: a menu that is five lines long
 * on one meeting and eight on the next is a menu you have to read from the top
 * every time, and "it is not there" and "it is not there yet" look identical
 * while you are hunting for it. Greyed says which of the two it is.
 *
 * <p>The three that *do* something — rematch, change language, regenerate —
 * also grey while one of them is still running. Two rewrites of one summary
 * raced in the same meeting is the concrete thing this prevents; the general
 * one is that none of the three is worth starting on a brief that is about to
 * be replaced. Copying is left alone, because copying what is on screen is
 * safe whatever is happening behind it.
 *
 * <p>Grouped by what an item acts on, and within that by what it costs to be
 * wrong. Filing and copying a link are free; then the transcript — copy it,
 * fix who said what, read it in another language; then the brief that was
 * written from it, which is the order those happen in, because rematching the
 * speakers or changing the language is the usual reason to regenerate.
 * Deleting the meeting is last and alone, so nothing lands there by momentum.
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
 * <p>What is deliberately not here: re-running the transcriber. "Transcribe
 * again" bought the same pipeline over the same audio at the price of every
 * hand correction and every speaker rename anybody had made, one confirm deep
 * in a menu people open to copy a link. POST /meetings/:id/reprocess is
 * untouched and `useReprocessMeetingMutation` is still exported, but nothing in
 * the app calls either — a meeting that failed to process is deleted and
 * uploaded again rather than retried in place.
 *
 * <p>"Change language" translates. It does not tell the transcriber it heard
 * the wrong language: that was a *different* item with the same name, it
 * re-transcribed from the audio, and having two controls saying "language" —
 * one of them destructive — is why this one was called "Read in another
 * language…" for a while. With the destructive one gone there is only one
 * thing here that says language, so it can have the shorter name. POST
 * /meetings/:id/language still exists and nothing calls it.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  ClipboardCopy,
  FileText,
  FolderInput,
  Languages,
  Link2,
  Loader2,
  MoreHorizontal,
  Sparkles,
  Trash2,
  SplitSquareHorizontal,
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
import { FOLDERS } from "@/lib/routes";

export interface MeetingMenuProps {
  meetingId: string;
  /** Where it is filed now, so Move can show the current answer as chosen. */
  projectId?: string | null;
  /**
   * There is a transcript to copy, and speakers in it worth rematching.
   *
   * False greys those items rather than removing them. See the note above.
   */
  hasTranscript: boolean;
  /** There is a summary to copy or rewrite. Greys both when false. */
  hasSummary: boolean;
  /**
   * There is something worth reading in another language.
   *
   * The dialog lives on the page, like the export one and for the same reason:
   * the language being read in decides what the whole page renders, so the page
   * has to own it.
   */
  canTranslate: boolean;
  /**
   * One of the three acting items is still running in the backend.
   *
   * Separate from `busy`, which closes the whole menu off while the meeting
   * itself is being deleted. This one leaves the menu usable — you can still
   * copy, file it, follow the link — and only stops a second rewrite landing
   * on top of the first.
   */
  working?: boolean;

  onCopySummary: () => void;
  onCopyTranscript: () => void;
  onRegenerateSummary: () => void;
  onTranslate: () => void;
  /**
   * Identify the unresolved speakers against voices this account has learned.
   *
   * Runs immediately. No dialog, no scrolling, no controls to fill in — the
   * whole operation is "work out who these people are", and there is nothing
   * for the user to tell us that we could use.
   */
  onRematchSpeakers: () => void;
  /**
   * Open the manual repair: merge two labels, or move a turn.
   *
   * A different problem from the one above, which is why both are on the menu.
   * Rematch answers "who is this?"; this answers "the transcriber split one
   * person in two". Neither can do the other's job.
   */
  onFixDiarization: () => void;
  onDelete: () => void;

  /**
   * A rematch is running.
   *
   * Its own flag rather than folding into `working`, because it shows on the
   * item itself: the operation takes a few seconds and gives no other sign it
   * started, so without this the honest reading of a still menu is that the
   * click missed.
   */
  rematching?: boolean;

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

          {/* The transcript: what was said, who said it, and what language you
              read it in. Together because they are one subject, and above the
              summary because the summary is written from them. */}
          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={!props.hasTranscript} onSelect={props.onCopyTranscript}>
            <FileText /> Copy transcript
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.hasTranscript || props.working || props.rematching}
            // Kept open while it runs. `onSelect` closes the menu by default,
            // and a menu that vanishes the instant you click is indistinguishable
            // from one that ignored you — which is exactly the doubt the spinner
            // below exists to answer.
            onSelect={(e) => {
              e.preventDefault();
              props.onRematchSpeakers();
            }}
          >
            {props.rematching ? <Loader2 className="animate-spin" /> : <Users />}
            {props.rematching ? "Rematching speakers…" : "Rematch speakers"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.hasTranscript || props.working}
            onSelect={props.onFixDiarization}
          >
            <SplitSquareHorizontal /> Fix diarization
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.canTranslate || props.working}
            onSelect={props.onTranslate}
          >
            <Languages /> Change language
          </DropdownMenuItem>

          {/* The brief, and the one control that rewrites it — which is what
              you reach for after correcting a name above, or to have it
              written in the language you just switched to. */}
          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={!props.hasSummary} onSelect={props.onCopySummary}>
            <ClipboardCopy /> Copy summary
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.hasSummary || props.working}
            onSelect={props.onRegenerateSummary}
          >
            <Sparkles /> Regenerate summary
          </DropdownMenuItem>

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
      toast.success(next ? "Moved." : "Moved out of the folder.");
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
              <Link href={FOLDERS}>Create one →</Link>
            </Button>
          </div>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto py-1">
            <Row
              label="No folder"
              hint="Stays on Home, in no folder."
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
