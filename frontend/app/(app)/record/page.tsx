"use client";

/**
 * Record a live meeting from the browser.
 *
 * One source: the microphone. There was a second mode that also captured the
 * audio of another tab, for meetings happening inside the browser, and it is
 * gone — see lib/use-recorder.ts for why. What is left needs no choosing, which
 * is most of the reason the page in front of it got shorter.
 *
 * The result goes down the same presigned-upload → create-meeting path the
 * import dialog uses, so processing is identical from there on.
 *
 * Nothing is asked before the microphone opens, and nothing is waited for. The
 * two questions that used to be here — which of two capture modes, and whether
 * the room had been told — were removed, the first because it had one answer
 * left and the second on request. The button that replaced them has gone too:
 * this route is only ever arrived at by pressing Record, and answering that
 * press with a second button asking whether you meant it is a step that exists
 * to be clicked through. Arriving here opens the microphone.
 *
 * That the browser still asks its own permission question is the point at which
 * this is not silent — it is the browser's prompt, it names the site, and it is
 * the only consent gate Reverie relies on.
 *
 * The consent tick going means Reverie no longer has anything to say about
 * consent for a recording, and says nothing rather than something convenient.
 * See where the meeting is created in components/recording-bar.tsx.
 *
 * The recorder itself lives in the shell too, so navigating away mid-meeting no
 * longer destroys the recording. This page is a view onto it: mount, unmount,
 * come back, and a running recording is still running.
 */

import * as React from "react";
import Link from "next/link";
import { Mic, Loader2, AlertTriangle, User, FileText, CalendarDays, Folder } from "lucide-react";
import { useGetPreferencesQuery, useGetProjectQuery } from "@/lib/api";
import { useRecording, useRecordingJob, useRecordingSession } from "@/lib/recording-context";
import type { LiveTurn } from "@/lib/use-live-transcript";
import { Button } from "@/components/ui/button";
import { stopwatch } from "@/lib/format";
import { folderHref, folderIdFrom, returnPath } from "@/lib/routes";
import { useAllowance, recordRefusal } from "@/lib/allowance";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function RecordPage() {
  const recorder = useRecording();
  const session = useRecordingSession();
  const job = useRecordingJob();
  const allowance = useAllowance();
  const refusal = recordRefusal(allowance);

  const started = recorder.state !== "idle";

  /**
   * Stop at the edge of the allowance.
   *
   * <p>`elapsed` is a whole-second counter and is exactly what is sent as the
   * recording's duration, so stopping the moment it reaches the balance lands
   * on a duration the server rounds to precisely the minutes that are left.
   * A second either way would be the difference between a meeting that saves
   * and one refused for being a minute over.
   *
   * <p>Stopping rather than refusing at save time is the entire point. The
   * meeting still exists, it is still transcribed, and what is lost is the part
   * that was never affordable — instead of the whole recording, which is what
   * a server-side refusal would cost somebody who had already sat through it.
   */
  const cutOff = React.useRef(false);
  React.useEffect(() => {
    if (recorder.state !== "recording") return;
    if (!Number.isFinite(allowance.secondsLeft)) return;
    if (recorder.elapsed < allowance.secondsLeft) return;
    if (cutOff.current) return;
    cutOff.current = true;
    recorder.stop();
    toast.warning(
      "That is the last of your 100 minutes, so the recording has been stopped here. What was recorded is safe — save it as usual.",
    );
  }, [recorder, recorder.state, recorder.elapsed, allowance.secondsLeft]);

  /**
   * The save has taken the audio, and the route is on its way out.
   *
   * <p>`save()` releases the recording before it navigates — the audio is on
   * the server and a second copy in the tab is one nothing reads. For the frame
   * or two between those two things this page is looking at an idle recorder,
   * and without this it drew the state it draws for an idle recorder: a spinner
   * saying "Waiting for permission…", as though it were about to start a
   * recording again. That flash is the last thing somebody sees of a meeting
   * they just saved.
   *
   * <p>Nothing at all is the right thing to draw here. The meeting's own page
   * is one tick away and it opens with the wait already on it; anything drawn
   * in between is a frame of something untrue.
   *
   * <p><b>It governs the whole page, not one panel of it.</b> It used to
   * suppress only the microphone half, which left the allowance notice below to
   * render on its own terms — and its own terms are `!started`, which is
   * precisely what releasing the audio makes true. Creating the meeting also
   * invalidates the usage cache, so a recording that spent the last of the
   * balance painted a destructive-tinted "There is nothing left to record with"
   * across the middle of the page at the exact moment the save succeeded, and
   * then navigated away from it. Every word of it true, and read as the save
   * having failed. The same applies to anything else that might be added here:
   * a page being handed over has nothing to say.
   *
   * <p>Narrowed to a recording this page actually held, rather than to any
   * pipeline running anywhere. Opening /record while an earlier meeting is
   * still processing is an ordinary arrival — there is nothing stopping you
   * recording the next one — and it should ask for the microphone like any
   * other, not sit blank behind somebody else's progress bar.
   */
  const held = React.useRef(false);
  if (started) held.current = true;
  const handingOver = !started && held.current && job.phase !== "idle";

  /**
   * Begin.
   *
   * <p>Nothing is told. There was a fire-and-forget POST to
   * {@code /recordings/started} here, whose only purpose was a "Recording
   * started" notification for the account's other devices — and that
   * notification is gone, because on the device doing the recording it
   * announced a timer, a waveform and a red Stop button that are already on
   * screen. It was one more row in a bell that had too many. The endpoint went
   * with it; see NotificationKind#retired.
   */
  async function onStart() {
    if (recordRefusal(allowanceRef.current)) return;
    await recorder.start();
  }

  // Read inside onStart rather than closed over, because the mount effect below
  // runs once and would otherwise capture the allowance as it was before the
  // first fetch resolved -- which is "unknown", and would refuse every
  // recording.
  const allowanceRef = React.useRef(allowance);
  allowanceRef.current = allowance;

  /**
   * Open the microphone on arrival.
   *
   * <p>The header's Record button already starts on its way here, so in the
   * ordinary case this finds a recording underway and does nothing. It exists
   * for every other way of reaching the route — a reload, the back button, a
   * bookmark — where the intent is identical and the old answer was a page
   * asking for the press a second time.
   *
   * <p>Once per mount, guarded by a ref rather than by the recorder's state. A
   * refusal puts the recorder back to idle and sets an error, so an effect that
   * keyed on idle would ask for the microphone again the instant it was denied,
   * and keep asking.
   */
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    // Wait for the balance before opening the microphone. Asking for it and
    // then refusing to record is a permission prompt spent on nothing.
    if (allowance.loading) return;
    opened.current = true;
    if (!recorder.supported) return;
    if (refusal) return;
    // Anything but idle means there is already a recording to show — running,
    // paused, or stopped and waiting to be saved. Which also means the header's
    // Record button started it, and has already said where it came from.
    if (recorder.state !== "idle") return;
    // So this is one of the other arrivals — a reload, the back button, a
    // bookmark — and the URL is the only thing left that knows. `?r=` is where
    // Record was pressed: the folder this files into, and the way back out.
    // Read from location rather than useSearchParams(), which would force the
    // route into a Suspense boundary at build time; same trade as
    // app/(app)/search/page.tsx.
    session.setReturnTo(returnPath(new URLSearchParams(window.location.search).get("r")));
    void onStart();
    // Runs when the allowance settles, then never again -- `opened` is set on
    // the first pass that gets past `loading`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowance.loading]);

  // After every hook, and before every notice. See `handingOver` above.
  if (handingOver) return null;

  return (
    // Clearance for the docked control bar is added by the shell, which knows
    // whether one is showing; adding it again here would leave a gap under the
    // setup, where there is no bar.
    <div className="mx-auto max-w-3xl space-y-6">
      {!started && refusal && !allowance.loading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="font-medium">There is nothing left to record with</p>
          <p className="mt-1 text-sm text-muted-foreground">{refusal}</p>
        </div>
      )}

      {!recorder.supported && (
        <Notice tone="error" icon={AlertTriangle}>
          This browser can&apos;t record audio.{" "}
          <Link href="/upload" className="underline underline-offset-2">
            Upload a file instead
          </Link>
          .
        </Notice>
      )}

      {recorder.error && (
        <Notice tone="error" icon={AlertTriangle}>
          {recorder.error}
        </Notice>
      )}

      {/* No pipeline branch. Saving leaves for Home and the wait happens in
          the meeting's own row there, so by the time there is anything to
          watch this page is behind you. */}
      {started && <NoteHeading startedAt={recorder.startedAt} />}

      {/* No `handingOver` arm here any more: the page returns before this when
          it is handing over, so reaching this line means there is genuinely no
          recording and no save in flight. */}
      {started ? (
        <InProgress state={recorder.state} />
      ) : (
        <Opening
          supported={recorder.supported}
          refused={recorder.error !== null}
          onRetry={() => void onStart()}
        />
      )}
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

/**
 * The body of a meeting that is being recorded.
 *
 * It says the transcript is not coming yet, because it is not. Reverie
 * transcribes after Stop — the audio is captured in the browser, uploaded, and
 * sent through the pipeline as one file. An empty pane that looked like it was
 * waiting for words would be a promise of live captions the product does not
 * make, and the person watching it would conclude their microphone was broken.
 */
function InProgress({ state }: { state: string }) {
  const { transcript } = useRecordingSession();
  const hasWords = transcript.turns.length > 0 || transcript.pending !== null;

  // Kept, and only this one, because the browser's permission prompt is modal
  // and a page with nothing on it behind that prompt gives no clue what is
  // being asked for or why.
  if (state === "requesting") return <WaitingForPermission />;

  if (state === "stopped") {
    return (
      <div className="space-y-4">
        {/* The words stay up after Stop. They are the only reminder of what was
            just said, and they are about to be thrown away — clearing the pane
            at the moment somebody is deciding whether to save or discard takes
            away the thing that decision is about. */}
        {hasWords && <Phrases />}
        <Empty>
          <FileText className="mx-auto h-7 w-7 text-muted-foreground" />
          <p className="mt-3 font-medium">Recording finished</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Save it below to transcribe it. Nothing has left this browser yet, so
            closing the tab now would lose the audio.
          </p>
          {/* What is on screen above is the live pass: fast, and made without
              hearing the end of the sentence. The canonical transcript is made
              from the whole file after saving, with the whole meeting in view,
              and replaces this. Said plainly so nobody reports the difference
              between the two as a bug. */}
          {hasWords && (
            <p className="mt-3 text-xs text-muted-foreground">
              These are the live results. The full transcript is written from
              the recording after you save, and will replace them.
            </p>
          )}
        </Empty>
      </div>
    );
  }

  /*
   * Recording, and nothing to say about it.
   *
   * There was a panel here announcing "Recording" over a pulsing microphone,
   * and under it either an explanation that the transcript comes later or an
   * invitation to switch live text on. It is gone. Every word of it was already
   * on screen — the timer is running in the bar, the waveform is moving, the
   * Stop button is red, and the live text toggle is right there — so the panel
   * restated what the controls were already saying, in the space the words are
   * about to occupy. Empty until there is something to put here is the point:
   * this is a page for a meeting, and the meeting has not said anything yet.
   */
  return (
    <div className="space-y-4">
      {hasWords && <Phrases />}

      {state === "paused" && hasWords && (
        <p className="text-center text-sm text-muted-foreground">
          Paused — nothing is being recorded or transcribed.
        </p>
      )}

      {/* A line, not a panel: live text failing says nothing about the
          recording, and dressing it up as a status board implies otherwise.

          The old disclaimer here — "a rough preview from your browser's speech
          service" — is gone with the thing it described. The words now come
          from the same provider that writes the final transcript, so calling
          them the browser's would be untrue. */}
      {transcript.status === "reconnecting" && (
        <p className="text-center text-xs text-muted-foreground">
          Reconnecting live text… the recording is unaffected.
        </p>
      )}
      {transcript.error && (
        <p className="text-center text-xs text-muted-foreground">{transcript.error}</p>
      )}
    </div>
  );
}

/**
 * The live text, as speaker turns.
 *
 * <p>This is what the finished transcript looks like — a speaker, a timestamp,
 * a paragraph — so it reads as an early draft of a thing the user will see
 * again rather than as a different feature. The turn still being spoken is
 * dimmed because it is going to change, sometimes completely, and presenting a
 * guess in the same weight as a settled line is how somebody comes to believe
 * the transcript got a name wrong.
 *
 * <p>It used to be one undifferentiated column under a generic avatar, because
 * the browser speech API behind it had no idea who was talking. Diarization is
 * the provider's now and arrives with the words.
 */
function Phrases() {
  const { transcript } = useRecordingSession();
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [transcript.turns.length, transcript.pending?.text]);

  return (
    <div className="space-y-5">
      {transcript.turns.map((turn) => (
        <Turn key={turn.id} turn={turn} />
      ))}

      {transcript.pending && <Turn turn={transcript.pending} provisional />}

      {/*
       * The scroll target, and the reason it carries a margin.
       *
       * `scrollIntoView` aligns to the viewport, which has no idea its bottom
       * edge is under a fixed control bar — so the newest line, the one this
       * exists to reveal, was scrolled to exactly where the bar covers it.
       * `scroll-margin-bottom` is the one property that says otherwise, and it
       * spends the same measured bar height the page padding does.
       */}
      <div
        ref={endRef}
        style={{ scrollMarginBottom: "calc(var(--recording-bar, 0px) + 3rem)" }}
      />
    </div>
  );
}

/**
 * One turn: who, when, and what.
 *
 * <p>An unattributed turn says so. It does not say "Speaker 1" — the provider
 * declining to name a voice and the provider naming the first voice are
 * different facts, and collapsing them puts a sentence beside somebody who may
 * not have said it. A short interjection at the start of a meeting is exactly
 * where diarization is least sure and exactly where a wrong name is most
 * likely to be believed.
 *
 * <p>The label is not final either way: AssemblyAI revises speaker labels as a
 * session goes on, so an unknown turn commonly resolves to a real speaker a
 * few seconds later without anybody doing anything.
 */
function Turn({ turn, provisional = false }: { turn: LiveTurn; provisional?: boolean }) {
  const unknown = turn.speakerStatus === "unknown";

  return (
    <div className={cn("flex gap-3", provisional && "opacity-60")}>
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
          unknown ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary",
        )}
        aria-hidden
      >
        {unknown ? <User className="h-3.5 w-3.5" /> : initials(turn.speaker)}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-xs text-muted-foreground">
          {unknown ? "Identifying speaker" : turn.speaker} · {stopwatch(turn.at)}
        </span>
        <p className="mt-0.5 text-[15px] leading-relaxed">{turn.text}</p>
      </div>
    </div>
  );
}

/** "Speaker 2" -> "2"; "Sarah Kaur" -> "SK". */
function initials(speaker: string): string {
  const numbered = /^Speaker\s+(\d+)$/.exec(speaker);
  if (numbered) return numbered[1];
  return speaker
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed p-8 text-center">{children}</div>;
}

/**
 * The moment before the microphone is open.
 *
 * <p>Shown both while the browser's prompt is up and in the frame before it
 * appears, so the page does not flicker through a third state on the way. The
 * words matter more than they look like they should: the prompt is modal and
 * renders over whatever is behind it, so a blank page underneath gives no clue
 * what is being asked for or by whom.
 */
function WaitingForPermission() {
  return (
    <Empty>
      <Loader2 className="mx-auto h-7 w-7 animate-spin text-muted-foreground" />
      <p className="mt-3 font-medium">Waiting for permission…</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Allow the microphone to start recording.
      </p>
    </Empty>
  );
}

/**
 * Arriving, and what happens when arriving does not work.
 *
 * <p>There is no idle state left to draw. What was here — "Ready to record", a
 * paragraph about what the microphone captures, a Start button and a panel
 * listing the four stages a recording goes through afterwards — was a page
 * standing between a press of Record and a recording. Every part of it either
 * restated the button that had just been pressed or described work that had not
 * started.
 *
 * <p>Two things still need drawing, and only because the microphone can refuse.
 * A browser that cannot record says so above, with a link to the page that can,
 * and needs nothing here. A refusal says so above too, and needs a way back:
 * the recording never began, so without this the route is a dead end with a red
 * banner on it, and the browser will not re-prompt without being asked.
 */
function Opening({
  supported,
  refused,
  onRetry,
}: {
  supported: boolean;
  refused: boolean;
  onRetry: () => void;
}) {
  if (!supported) return null;

  if (refused) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Nothing was recorded. Allow the microphone in your browser, then try again.
        </p>
        <Button className="gap-2" onClick={onRetry}>
          <Mic className="h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }

  return <WaitingForPermission />;
}

/**
 * What this note is, while it is being taken.
 *
 * <p>Only once recording has started. Before that there is no note: a name
 * field over an empty page would be asking somebody to title a meeting that has
 * not happened, at the one moment nobody can answer.
 *
 * <p>The name is optional and empty rather than pre-filled. A placeholder can
 * be ignored; a value has to be deleted before anything can be typed, which is
 * how a date-stamped name nobody chose ends up defended by the delete key.
 * Left blank it falls back to the date on save — but somebody who knows this is
 * the Tuesday design review can say so while it is still true, instead of
 * hunting for the meeting afterwards to rename it.
 *
 * <p>The date is fixed at the moment recording began rather than read from the
 * clock, so the heading does not tick over while the meeting runs.
 */
function NoteHeading({ startedAt }: { startedAt: Date | null }) {
  const prefs = useGetPreferencesQuery();
  const { title, setTitle, returnTo } = useRecordingSession();
  const folderId = folderIdFrom(returnTo);
  const owner = prefs.data?.displayName?.trim();
  const when = startedAt ?? new Date();

  return (
    <div className="space-y-2 border-b pb-4">
      <label className="sr-only" htmlFor="recording-title">
        Name this note
      </label>
      <input
        id="recording-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note"
        className={cn(
          "w-full rounded-lg border-2 border-transparent bg-transparent px-3 py-2",
          "text-3xl font-semibold tracking-tight outline-none transition-colors",
          "placeholder:font-normal placeholder:italic placeholder:text-muted-foreground/60",
          "hover:border-input focus:border-primary focus:bg-background",
        )}
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CalendarDays className="h-4 w-4 shrink-0" />
          {noteDate(when)}
        </span>
        {/* Only once it is known. "Owner: —" is worse than no line: it reads as
            a missing value rather than as a name nobody has set. */}
        {owner && (
          <span className="flex items-center gap-1.5">
            <User className="h-4 w-4 shrink-0" />
            Owner: {owner}
          </span>
        )}
        {/* Where this will be filed, if Record was pressed inside a folder.
            Said now rather than discovered later: the folder was chosen a
            screen ago and several minutes before the meeting will exist, which
            is long enough to have stopped being sure. Absent entirely when
            there is none — "Folder: —" reads as a missing value rather than as
            a meeting that belongs nowhere in particular. */}
        {folderId && <FilingInto projectId={folderId} />}
      </div>
    </div>
  );
}

/** "Wed, Aug 19, 2026 · 6:05 AM" — the day named, because a meeting has one. */
function noteDate(when: Date): string {
  const day = when.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "warn" | "error";
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-400",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/**
 * The folder this recording will land in.
 *
 * Only the name is wanted, and only once it has arrived. Rendering the id, or a
 * skeleton, in a row of plain facts would be worse than waiting a moment.
 */
function FilingInto({ projectId }: { projectId: string }) {
  const { data: project } = useGetProjectQuery(projectId);
  if (!project) return null;

  return (
    <span className="flex items-center gap-1.5">
      <Folder className="h-4 w-4 shrink-0" />
      Folder:{" "}
      {/* A link, because it is the way back to what was on screen when Record
          was pressed. Leaving mid-recording is safe — the recorder lives in the
          shell and the bar follows — so there is no reason to strand anybody
          here. */}
      <Link href={folderHref(project.id)} className="underline underline-offset-2">
        {project.name}
      </Link>
    </span>
  );
}
