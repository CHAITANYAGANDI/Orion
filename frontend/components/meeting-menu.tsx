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
 * the brief, re-transcribing throws away every correction anybody made, and the
 * bottom group deletes things. The separators are where the cost changes, and
 * the destructive group is last so nothing lands there by momentum.
 *
 * <p>Two of the operations open dialogs and own their own state here, because
 * both are self-contained given a meeting id: choosing a project, and saying
 * what language the room was speaking. The rest are callbacks — their data
 * (the summary, the segments, the erasure timestamps) lives on the page.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Check,
  Download,
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
  useSetMeetingLanguageMutation,
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
  /** What the user last told us this meeting is in, or null for the account default. */
  spokenLanguage?: string | null;
  /** What the transcriber reported hearing. Shown when it disagrees with the above. */
  detectedLanguage?: string | null;

  /**
   * The export dialog exists on the page.
   *
   * It is only mounted for a processed meeting, so offering the item before
   * then would be a click that opens nothing — the worst kind of dead control,
   * because it looks exactly like one that failed.
   */
  canExport: boolean;
  /** There is a transcript to copy, and speakers in it worth rematching. */
  hasTranscript: boolean;
  /** There is a summary to copy or rewrite. */
  hasSummary: boolean;
  /** There is a source to run the pipeline over again. */
  canReprocess: boolean;
  canEraseAudio: boolean;
  canEraseTranscript: boolean;

  onExport: () => void;
  onCopySummary: () => void;
  onCopyMinutes: () => void;
  onCopyTranscript: () => void;
  onRegenerateSummary: () => void;
  onRematchSpeakers: () => void;
  onReprocess: () => void;
  onEraseAudio: () => void;
  onEraseTranscript: () => void;
  onDelete: () => void;

  /** Greys the whole menu while something it started is in flight. */
  busy?: boolean;
}

export function MeetingMenu(props: MeetingMenuProps) {
  const [moving, setMoving] = React.useState(false);
  const [changingLanguage, setChangingLanguage] = React.useState(false);

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
          {props.canExport && (
            <DropdownMenuItem onSelect={props.onExport}>
              <Download /> Export audio &amp; text
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setMoving(true)}>
            <FolderInput /> Move…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyLink()}>
            <Link2 /> Copy link
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {props.hasSummary && (
            <>
              <DropdownMenuItem onSelect={props.onCopySummary}>Copy summary</DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onCopyMinutes}>
                Copy formatted minutes
              </DropdownMenuItem>
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
            <>
              <DropdownMenuItem onSelect={() => setChangingLanguage(true)}>
                <Languages /> Change language…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={props.onReprocess}>
                <RefreshCw /> Transcribe again
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />

          {props.canEraseAudio && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={props.onEraseAudio}
            >
              Delete the recording, keep the notes
            </DropdownMenuItem>
          )}
          {props.canEraseTranscript && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={props.onEraseTranscript}
            >
              Delete the transcript, keep the summary
            </DropdownMenuItem>
          )}
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
      <ChangeLanguageDialog
        open={changingLanguage}
        onOpenChange={setChangingLanguage}
        meetingId={props.meetingId}
        current={props.spokenLanguage}
        detected={props.detectedLanguage}
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

/* --------------------------- Change language ---------------------------- */

/**
 * Telling the transcriber what language the room was speaking.
 *
 * <p>The reason this is a dialog and not a picker is the sentence in the
 * middle. Changing the language is not a setting, it is a re-transcription: it
 * replaces every word of the current transcript, and with it every correction
 * anybody typed. Somebody who thought they were relabelling a field would find
 * that out afterwards.
 *
 * <p>Only the languages Recallix can actually transcribe are offered. The
 * translation picker looks similar and means something else entirely — that one
 * reads an English meeting in French, this one says the meeting *was* in French.
 */
function ChangeLanguageDialog({
  open,
  onOpenChange,
  meetingId,
  current,
  detected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  current?: string | null;
  detected?: string | null;
}) {
  const { data: languages } = useGetLanguagesQuery();
  const [setLanguage, { isLoading }] = useSetMeetingLanguageMutation();
  const [picked, setPicked] = React.useState<string>(current ?? "");

  // Re-seeded per opening, so a language considered and abandoned last time is
  // not sitting there pre-selected the next.
  React.useEffect(() => {
    if (open) setPicked(current ?? "");
  }, [open, current]);

  const detectedName = languages?.find((l) => l.code === detected)?.name;

  async function apply() {
    try {
      await setLanguage({ id: meetingId, language: picked }).unwrap();
      toast.success("Transcribing again. This takes about as long as it did the first time.");
      onOpenChange(false);
    } catch (e) {
      const message =
        typeof e === "object" && e && "data" in e
          ? (e as { data?: { message?: string } }).data?.message
          : undefined;
      toast.error(message || "Couldn't change the language.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What language is this meeting in?</DialogTitle>
          <DialogDescription>
            {detectedName
              ? `The transcriber heard ${detectedName}. If that is wrong, say so here and it will listen again.`
              : "Tell the transcriber what to expect, and it will listen again."}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-64 space-y-1 overflow-y-auto py-1">
          <Row
            label="Use my account default"
            hint="Detects, unless you set one"
            selected={picked === ""}
            disabled={isLoading}
            onSelect={() => setPicked("")}
          />
          {(languages ?? []).map((l) => (
            <Row
              key={l.code}
              label={l.name}
              hint={l.nativeName === l.name ? undefined : l.nativeName}
              selected={picked === l.code}
              disabled={isLoading}
              onSelect={() => setPicked(l.code)}
            />
          ))}
        </ul>

        {/* The cost, stated before the button rather than in a toast after it.
            This is the one item on the menu that destroys work somebody did by
            hand. */}
        <p className="rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
          This transcribes the recording again from the start. The new transcript
          replaces the one on screen, including any lines you corrected, and the
          summary is rewritten from it. Highlights and notes keep their
          timestamps.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={isLoading}>
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            Transcribe again
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
