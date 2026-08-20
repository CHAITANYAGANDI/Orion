"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  RefreshCw,
  Download,
  Loader2,
  AlertTriangle,
  Clock,
  Sparkles,
  Send,
  Languages,
  Users,
  Check,
  Quote,
  Youtube,
  Pencil,
  Search,
  X,
  Bookmark,
  Highlighter,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  ClipboardCopy,
  ListChecks,
  MessageSquare,
  Square,
} from "lucide-react";
import {
  useGetMeetingQuery,
  useGetSummaryQuery,
  useGetTranscriptQuery,
  useGetMeetingActionItemsQuery,
  useReprocessMeetingMutation,
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useTranslateMeetingMutation,
  useGetTranslationsQuery,
  useGetLanguagesQuery,
  useRenameSpeakersMutation,
  useRematchSpeakerMutation,
  useGetKnownSpeakersQuery,
  useEditSegmentsMutation,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
  useGetMomentsQuery,
  useGetInsightsQuery,
  useCreateMomentMutation,
  useDeleteMomentMutation,
  useGetMeetingConversationsQuery,
  useCreateMeetingConversationMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
} from "@/lib/api";
import type {
  SpeakerStats,
  SpokenWord,
  MeetingTranslation,
  SummaryResponse,
  SummarySection,
} from "@/lib/types";
import { useActiveChat } from "@/lib/active-chat";
import { HeaderSlot } from "@/components/header-slot";
import { Button } from "@/components/ui/button";
import { useRecordingJob } from "@/lib/recording-context";
import { ProcessingCard } from "@/components/processing-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ActionItemRow } from "@/components/action-item-row";
import { NewActionItemDialog } from "@/components/new-action-item-dialog";
import { TranslationDialog, ReadingIn, ORIGINAL } from "@/components/translation-dialog";
import { TranslatedTranscript } from "@/components/translated-transcript";
import { AudioPlayer, useAudioController } from "@/components/audio-player";
import { ShareDialog } from "@/components/share-dialog";
import { MeetingTitle, MeetingTags } from "@/components/meeting-title";
import { OutlineNav } from "@/components/outline-nav";
import { MeetingMenu } from "@/components/meeting-menu";
import { InsightsPanel } from "@/components/insights-panel";
import { ExportDialog } from "@/components/export-dialog";
import { copySummary, copyTranscript } from "@/lib/minutes";
import { subscribeMeetingStatus } from "@/lib/ws";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  statusLabel,
  statusProgress,
  isTerminal,
  timecode,
} from "@/lib/format";
import { languageName } from "@/lib/language";
// Shared with the transcript editor, so reading and correcting agree about
// where the paragraphs are and the page does not reflow when you switch modes.
import { groupIntoTurns, type Turn } from "@/lib/turns";
import { SpeakerAvatar } from "@/components/speaker-avatar";
import { TurnActions, TurnReactions } from "@/components/turn-actions";
import {
  TranscriptEditor,
  type TranscriptEditorHandle,
  type TranscriptEditorStatus,
} from "@/components/transcript-editor";
import { ChatSuggestions } from "@/components/chat-suggestions";
import { ChatHistory } from "@/components/chat-history";
import { ChatMessageBubble } from "@/components/chat-message";
import { MEETING_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { SelectionMenu, type SelectionAction } from "@/components/selection-menu";
import { MomentsPanel } from "@/components/moments-panel";
import { ActionItemDialog, NoteDialog, type Passage } from "@/components/moment-composer";
import {
  askPrefix,
  attributedQuote,
  isMarked,
  readSelection,
  segmentMarks,
  summarizePrompt,
  tokenize,
  type SegmentMark,
  type SelectionCapture,
} from "@/lib/moments";
import { cn } from "@/lib/utils";
import type {
  MeetingStatus,
  MomentKind,
  StatusEvent,
  TranscriptMoment,
  TranscriptSegment,
} from "@/lib/types";

export default function MeetingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [live, setLive] = React.useState<StatusEvent | null>(null);
  const meeting = useGetMeetingQuery(id);

  /**
   * The save that is still running, if it is this meeting's.
   *
   * <p>Saving a recording lands here, so the docked bar stands down and this
   * page carries the wait — including the one control that ends it. Matched on
   * the id: the bar may be following a different meeting entirely, and offering
   * to stop that one from this page would delete something not on screen.
   */
  const recordingJob = useRecordingJob();
  const stoppable = recordingJob.phase === "processing" && recordingJob.job?.id === id;

  /**
   * Call the pipeline off, which means deleting what it is working on.
   *
   * <p>The worker is mid-flight and cannot be recalled. Once the meeting is
   * gone this page is about nothing, so it leaves for the list rather than
   * sitting on a 404 of the thing it just deleted.
   */
  async function stopProcessing() {
    if (
      !window.confirm(
        "Stop processing?\n\nThe meeting and its recording are deleted. The audio " +
          "only exists on the server now, so this cannot be undone.",
      )
    ) {
      return;
    }
    if (await recordingJob.stop()) router.push("/home");
  }

  /**
   * Controlled so the transcript can hand a selection to the chat.
   * "Ask Recallix" about a highlighted sentence has to leave the tab it was
   * invoked from, which an uncontrolled Tabs cannot do.
   */
  const [tab, setTab] = React.useState("summary");

  /**
   * Correcting the whole transcript, as a mode.
   *
   * The state is here rather than in the panel because the control that leaves
   * the mode sits on the tab row, which is this component's markup. The drafts
   * stay down in the editor; it publishes what the button needs to draw itself
   * through `onStatus`, and what the button needs to *do* through the ref.
   */
  /**
   * Bumped by "Rematch speakers" on the menu, and read by the transcript panel
   * as "open the speaker tools and scroll to them". A counter, so pressing the
   * item a second time works a second time.
   */
  const [speakerTools, setSpeakerTools] = React.useState(0);
  const [resummarize] = useResummarizeMutation();

  const [editingTranscript, setEditingTranscript] = React.useState(false);
  const transcriptEditor = React.useRef<TranscriptEditorHandle>(null);
  const [editStatus, setEditStatus] = React.useState<TranscriptEditorStatus>({
    dirty: 0,
    saving: false,
  });
  const onEditStatus = React.useCallback((next: TranscriptEditorStatus) => {
    setEditStatus(next);
  }, []);
  const leaveEditing = React.useCallback(() => setEditingTranscript(false), []);

  /**
   * Switching tabs out of an unsaved correction pass.
   *
   * The editor asks before discarding, and refuses to close if the answer is
   * no — so a tab change that would have thrown the work away is refused with
   * it, rather than happening anyway behind a dialog the user already declined.
   */
  function changeTab(next: string) {
    if (editingTranscript && next !== "transcript" && !transcriptEditor.current?.cancel()) {
      return;
    }
    setTab(next);
  }

  /**
   * Text pushed into the chat from elsewhere on the page.
   *
   * Carries a nonce because the same passage can be asked about twice, and a
   * bare string would compare equal the second time and never re-fire. `send`
   * distinguishes a complete prompt ("summarize this") from an opening the user
   * still has to finish ("about this passage: …").
   */
  const [composed, setComposed] = React.useState<{
    text: string;
    send: boolean;
    nonce: number;
  } | null>(null);

  // No tab switch any more: the chat lives in the rail beside the transcript,
  // so asking about a passage no longer costs the passage. That was the whole
  // reason this had to move the reader somewhere else.
  const askAbout = React.useCallback((text: string, send: boolean) => {
    setComposed({ text, send, nonce: Date.now() });
  }, []);

  const status: MeetingStatus = (live?.status ?? meeting.data?.status ?? "CREATED") as MeetingStatus;
  const ready = status === "READY";
  const failed = status === "FAILED";
  const terminal = isTerminal(status);

  const audio = useAudioController();

  React.useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => meeting.refetch(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, id]);

  React.useEffect(() => {
    const sub = subscribeMeetingStatus(id, {
      onEvent: (e) => {
        setLive(e);
        if (isTerminal(e.status)) meeting.refetch();
      },
    });
    return () => sub.deactivate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Play from a moment, wherever the ask came from.
   *
   * <p>The player only exists on the transcript now, so every other caller — a
   * quotation in the brief, an action item's source, a `?t=` deep link — is
   * asking to hear something while looking at a tab that has nothing to play
   * it. Each of those used to call `seekTo` straight, and would now silently
   * do nothing.
   *
   * <p>So the moment is parked and the tab is switched. The effect below runs
   * after the commit that mounts the player, which is the earliest point there
   * is a media element to seek. Landing on the transcript is the right answer
   * anyway: somebody who clicked a citation wants to see the words as well as
   * hear them.
   */
  const pendingSeek = React.useRef<number | null>(null);

  const seekWhenReady = React.useCallback(
    (seconds: number) => {
      const el = audio.ref.current;
      if (!el) return;
      const seek = () => audio.seekTo(seconds);
      // Seeking before metadata lands is dropped by the browser, which is what
      // made a deep link into a long recording start from zero.
      if (el.readyState >= 1) seek();
      else el.addEventListener("loadedmetadata", seek, { once: true });
    },
    [audio],
  );

  function playFrom(seconds: number) {
    if (tab === "transcript") {
      seekWhenReady(seconds);
      return;
    }
    pendingSeek.current = seconds;
    changeTab("transcript");
  }

  React.useEffect(() => {
    if (tab !== "transcript") return;
    const t = pendingSeek.current;
    if (t == null) return;
    pendingSeek.current = null;
    seekWhenReady(t);
  }, [tab, seekWhenReady]);

  // Deep link from a workspace-chat citation or a semantic search hit:
  // /meetings/{id}?t=132.5 opens the meeting and seeks to that moment.
  // Read from location rather than useSearchParams() so the page stays
  // prerenderable without a Suspense boundary.
  const seekedRef = React.useRef(false);
  React.useEffect(() => {
    if (seekedRef.current || !ready) return;
    const t = Number(new URLSearchParams(window.location.search).get("t"));
    if (!Number.isFinite(t) || t <= 0) return;
    seekedRef.current = true;
    pendingSeek.current = t;
    // Not playFrom(): this runs on the first ready render, when the tab is
    // still the default, so it has to go through the switch rather than around
    // it.
    changeTab("transcript");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const summary = useGetSummaryQuery(id, { skip: !ready });
  const transcript = useGetTranscriptQuery(id, { skip: !ready });
  const actions = useGetMeetingActionItemsQuery(id, { skip: !ready });
  // The tab counts what is left, not what was found. "Action items 6" beside a
  // list where five are ticked off reads as six things to do.
  const openActions = (actions.data ?? []).filter((a) => a.status !== "DONE").length;
  // Also read inside the transcript panel; RTK Query dedupes to one request.
  // Fetched here because the player needs it for "play highlights only".
  const moments = useGetMomentsQuery(id, { skip: !ready });
  // And here because minutes open with the decisions. The InsightsPanel asks
  // for the same thing, and RTK Query serves both from one request.
  const insights = useGetInsightsQuery(id, { skip: !ready });

  /**
   * What language the meeting is being read in.
   *
   * Held here rather than in a panel because it applies to all three tabs: the
   * brief, the tasks and the transcript are one meeting, and translating the
   * summary while the transcript beside it stays in the source language is the
   * behaviour this replaced.
   *
   * The mutation is fired on every switch, including back to a language already
   * translated — the server returns what it has without spending a model call,
   * which is what lets this component avoid tracking what exists.
   */
  const [readingIn, setReadingIn] = React.useState<string>(ORIGINAL);
  const [translate, { data: translation, isLoading: translating, reset: clearTranslation }] =
    useTranslateMeetingMutation();
  const availableTranslations = useGetTranslationsQuery(id, { skip: !ready });
  // Also asked for by the translation bar; RTK Query serves both from one
  // request. Read here so an export can say what the recording is still in.
  const languages = useGetLanguagesQuery();
  const showing = readingIn === ORIGINAL ? undefined : translation;

  async function onReadIn(next: string, includeTranscript = false) {
    setReadingIn(next);
    if (next === ORIGINAL) {
      clearTranslation();
      return;
    }
    try {
      await translate({ id, targetLanguage: next, includeTranscript }).unwrap();
    } catch {
      toast.error("Could not translate this meeting.");
      setReadingIn(ORIGINAL);
    }
  }

  const [reprocess, reprocessState] = useReprocessMeetingMutation();
  const [remove, removeState] = useDeleteMeetingMutation();

  /**
   * The download dialog, opened from the export menu.
   *
   * Held here rather than inside the menu because a Radix menu closes when an
   * item is chosen, and a dialog mounted inside it would be unmounted in the
   * same frame it was asked to open.
   */
  const [exporting, setExporting] = React.useState(false);

  /** The reading-language dialog, opened from the same menu. */
  const [pickingLanguage, setPickingLanguage] = React.useState(false);

  /**
   * What goes on the clipboard, in two shapes.
   *
   * The summary is prose you paste into a reply; the minutes are a document you
   * paste into a doc or an email. Speakers come from the transcript because
   * "Present:" is the line every set of minutes opens with, and Recallix knows
   * who spoke without anyone having typed an attendee list.
   */
  function minutesInput() {
    const speakers = Array.from(
      new Set((transcript.data?.segments ?? []).map((s) => s.speaker).filter(Boolean)),
    );
    return {
      meeting: meeting.data!,
      summary: summary.data,
      actionItems: actions.data,
      insights: insights.data,
      speakers,
    };
  }

  async function onCopySummary() {
    if (!meeting.data) return;
    const ok = await copySummary(minutesInput());
    if (ok) toast.success("Summary copied.");
    else toast.error("Nothing to copy yet.");
  }

  async function onCopyTranscript() {
    const ok = await copyTranscript(transcript.data?.segments ?? []);
    if (ok) toast.success("Transcript copied.");
    else toast.error("Nothing to copy yet.");
  }

  /**
   * Write the brief again, under the template it already uses.
   *
   * The same call the template picker makes, with the current slug rather than
   * a new one — which is what "regenerate" means. Worth having separately from
   * the picker because the commonest reason to want it has nothing to do with
   * templates: the transcript was corrected, and the summary still asserts what
   * it used to say.
   */
  async function onRegenerateSummary() {
    try {
      await resummarize({ id, template: summary.data?.templateSlug ?? "general" }).unwrap();
      toast.success("Summary rewritten from the current transcript.");
    } catch {
      toast.error("Could not rewrite the summary.");
    }
  }

  /**
   * Send the reader to the speaker tools, wherever they were.
   *
   * A counter rather than a boolean: pressing the menu item twice has to work
   * twice, and a flag that is already true is a second press that does nothing.
   */
  function onRematchSpeakers() {
    changeTab("transcript");
    setSpeakerTools((n) => n + 1);
  }

  async function onReprocess() {
    if (
      !window.confirm(
        "Transcribe this recording again?\n\nThe new transcript replaces the one " +
          "on screen, including any lines you corrected, and the summary is " +
          "rewritten from it.",
      )
    ) {
      return;
    }
    try {
      await reprocess(id).unwrap();
      setLive(null);
      toast.success("Transcribing again.");
    } catch {
      toast.error("Could not reprocess.");
    }
  }

  async function onDelete() {
    if (!window.confirm("Delete this meeting and all its data?")) return;
    try {
      await remove(id).unwrap();
      toast.success("Meeting deleted.");
      router.push("/search");
    } catch {
      toast.error("Could not delete.");
    }
  }

  if (meeting.isLoading) return <Skeleton className="h-64 w-full" />;
  if (meeting.isError || !meeting.data) {
    return (
      <div className="text-center">
        <p className="text-lg font-medium">Meeting not found</p>
        <Button className="mt-4" variant="outline" asChild>
          <Link href="/search">Back to meetings</Link>
        </Button>
      </div>
    );
  }

  const m = meeting.data;
  // A PDF was never spoken: no audio, no timeline, nothing to seek to.
  const isDocument = m.sourceType === "DOCUMENT";
  const isVideoUpload = !!m.contentType && m.contentType.startsWith("video/");
  /** Whether the last stretch of the page sits under a floating bar. */
  const docked = ready && !!m.audioUrl && !isDocument && !isVideoUpload && tab === "transcript";
  const player = (
    <AudioPlayer
      src={m.audioUrl ?? ""}
      controller={audio}
      contentType={m.contentType}
      // Skip-silence, the speaker jumps and the coloured timeline are all read
      // out of the transcript rather than the audio signal — see
      // lib/playback.ts. Both queries are already in flight for the tabs below,
      // so RTK Query serves these from the same request.
      segments={transcript.data?.segments ?? []}
      moments={moments.data ?? []}
    />
  );
  // Only offered when there is something to erase. A YouTube import holds no
  // recording of ours, and offering to delete one would imply we had it.

  return (
    /* The docked player floats, so the page has to leave it room; without this
       the last lines of a transcript sit under the bar and can be neither read
       nor corrected. */
    <div className={cn("space-y-6", docked && "pb-32")}>
      {/* Masthead. The metadata sits in a monospaced rule under the title
          rather than as a row of loose badges: these are facts about one
          document, and setting them as a spec line keeps the title the only
          thing competing for first read. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* No "All meetings" link. The rail is always there and already says
              where everything is; a second way back, drawn above the title,
              pushed the one thing this page is about down the screen. */}
          <MeetingTitle id={id} title={m.title} />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {/* No status here. Anything other than READY is already announced
                below, and far louder — a progress card while it works, a
                destructive card with the provider's own message when it
                fails. A badge reading READY beside a meeting you are plainly
                reading is a label for the only state that needs none. */}
            {/* A document has no runtime, so a duration would be meaningless. */}
            {!isDocument && (
              <>
                <span className="tabular inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> {formatDuration(m.durationSeconds)}
                </span>
                <span className="text-border" aria-hidden>/</span>
              </>
            )}
            <span className="tabular">{formatDateTime(m.createdAt)}</span>
            {/* Only worth showing when it isn't the default — an "English"
                badge on every meeting is noise. */}
            {m.language && m.language.slice(0, 2).toLowerCase() !== "en" && (
              <>
                <span className="text-border" aria-hidden>/</span>
                <span>{languageName(m.language)}</span>
              </>
            )}
            {isDocument && (
              <>
                <span className="text-border" aria-hidden>/</span>
                <span>Document</span>
              </>
            )}
            {m.sourceType === "YOUTUBE" && m.sourceUrl && (
              <>
                <span className="text-border" aria-hidden>/</span>
                <a
                  href={m.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 underline underline-offset-2 hover:text-foreground"
                >
                  <Youtube className="h-3.5 w-3.5" /> YouTube
                </a>
              </>
            )}
            {/* Not while it is still working. Tagging a meeting you cannot
                read yet is filing a document you have not seen, and the spec
                line is better off short on the one screen that is otherwise a
                title and a progress bar. It comes back with the transcript. */}
            {terminal && <MeetingTags id={id} tags={m.tags ?? []} />}
            {/* In the spec line, beside the facts, rather than only inside the
                Export menu. Copying the summary is the single commonest thing
                anybody does with one — it goes into a reply or a doc — and it
                was two clicks behind a menu named after downloading files,
                which is the rarer thing. It stays in the menu too, for whoever
                already knows where it is. */}
            {ready && (
              <>
                <span className="text-border" aria-hidden>/</span>
                <button
                  type="button"
                  onClick={() => void onCopySummary()}
                  className="no-print inline-flex items-center gap-1.5 uppercase tracking-wide hover:text-foreground"
                >
                  <ClipboardCopy className="h-3.5 w-3.5" /> Copy summary
                </button>
              </>
            )}
            {/* Only ever rendered while a translation is on screen. The picker
                is behind the ⋯ menu now, so this is the one thing telling a
                reader that the words in front of them are not the ones that
                were said. */}
            <ReadingIn
              sourceLanguage={m.language}
              language={readingIn}
              translation={showing}
              busy={translating}
              onShowOriginal={() => void onReadIn(ORIGINAL)}
              onRetranslate={() => void onReadIn(readingIn, !!showing?.hasTranscript)}
            />
          </div>
        </div>
        {/* Up in the top bar, on the same line as search — not beside the
            title. Two rows of controls within an inch of each other, the
            shell's above and the document's below, and neither row explaining
            why it was not the other one. The dialogs and every piece of state
            they need stay here; only the buttons are drawn elsewhere. See
            components/header-slot.tsx. */}
        <HeaderSlot>
        {/* Cleared past the chat rail, whose widths these mirror — see the
            `aside` below. The shell's header spans the window while this page
            is a centred column, so on a wide screen these already sit outside
            the rail; on a narrow one, where the column fills the width, they
            would land directly over it. */}
        <div className="flex items-center gap-2 no-print lg:mr-[22rem] xl:mr-[26rem]">
          {ready && (
            <>
              <ShareDialog meetingId={id} />
              {/* A button, not a menu. Everything that used to hang off it —
                  copying, erasing — moved onto the one menu that holds every
                  other operation, so a control named Export now does exactly
                  what it says. */}
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setExporting(true)}>
                <Download className="h-4 w-4" /> Export
              </Button>
              <ExportDialog
                open={exporting}
                onOpenChange={setExporting}
                meetingId={id}
                // Handed the data the page already has, so the preview costs no
                // request and updates the moment a tickbox moves.
                summary={showing ? undefined : summary.data}
                actionItems={actions.data ?? []}
                segments={transcript.data?.segments ?? []}
                audioContentType={m.contentType}
                transcriptLines={transcript.data?.segments?.length ?? 0}
                // The file is written in whatever the page is being read in, so
                // exporting a translation you are looking at needs no second
                // choice — and cannot silently give you the English instead.
                language={readingIn === ORIGINAL ? null : readingIn}
                languageName={showing?.languageName}
                sourceLanguageName={
                  languages.data?.find((l) => l.code === m.language)?.name ?? null
                }
                hasAudio={!isDocument && !!m.audioUrl}
              />
            </>
          )}
          {/* Everything else, in one place and ordered by what it costs to be
              wrong. Rendered whatever the status, because deleting a meeting
              that failed to process is the commonest thing to want to do with
              one.

              Filing is in here too, as Move. It used to sit in the spec line
              above as a folder picker, which meant every meeting carried a
              visible "Unfiled" — a label reading as a problem to fix on the
              overwhelming majority of meetings, in the one place somebody came
              to read rather than to tidy. Which folder a meeting is in is a
              thing you go and change, not a fact about the meeting worth
              stating beside its date. */}
          {/* Hidden while processing. Everything in it that needs a
              transcript is already gated off at that point, so what is left is
              Move, Copy link and Delete — three actions nobody wants mid-wait,
              drawn as a menu button in the corner of a page with one card on
              it. It returns the moment the meeting is READY or FAILED, which
              is when Delete and Transcribe again start to matter. */}
          {terminal && <MeetingMenu
            meetingId={id}
            projectId={m.projectId}
            hasTranscript={(transcript.data?.segments?.length ?? 0) > 0}
            hasSummary={ready && Boolean(summary.data)}
            canTranslate={ready}
            canReprocess={terminal && (!!m.audioUrl || !!m.sourceUrl)}
            busy={reprocessState.isLoading || removeState.isLoading}
            onCopySummary={() => void onCopySummary()}
            onCopyTranscript={() => void onCopyTranscript()}
            onRegenerateSummary={() => void onRegenerateSummary()}
            onTranslate={() => setPickingLanguage(true)}
            onRematchSpeakers={onRematchSpeakers}
            onReprocess={() => void onReprocess()}
            onDelete={() => void onDelete()}
          />}
        </div>
        </HeaderSlot>
      </div>

      {/* The player, over the transcript and nowhere else.
          A DOCUMENT's presigned URL points at the source PDF, not audio, so it
          stays away from those entirely.

          Only on the transcript because that is the tab it acts on: the
          scrubber is banded by who is speaking, the jumps are speaker jumps,
          and the highlighted line follows the clock. Over a summary it drove
          something not on screen while taking a band of the page on every
          visit, and most visits to a brief never play anything.

          Docked rather than in the flow so it stays put while the transcript
          scrolls under it, which is the whole reason to have it there: reading
          along and correcting are the same sitting. The left offset matches the
          rail, so "centred" means centred on the transcript rather than on the
          window. Below the recording bar's z-index — a live microphone is the
          more urgent of the two. */}
      {ready && m.audioUrl && !isDocument && tab === "transcript" && (
        isVideoUpload ? (
          /* A video is watched, not scrubbed past. The same component renders a
             frame up to 60vh tall, and floating that over the transcript would
             cover the thing it is meant to be read alongside. */
          <div className="no-print">{player}</div>
        ) : (
          <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-20 p-3 sm:p-4 lg:left-64">
            <div className="pointer-events-auto mx-auto max-w-3xl">{player}</div>
          </div>
        )
      )}

      {/* Said out loud rather than left as an absence. "No audio" is also true
          of a YouTube import and of an upload still in flight, and a page that
          cannot tell those apart has to give all three the least useful of the
          three answers. */}
      {(m.audioDeletedAt || m.transcriptDeletedAt) && (
        <p className="no-print flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {m.audioDeletedAt && (
              <>You deleted the recording on {formatDate(m.audioDeletedAt)}. </>
            )}
            {m.transcriptDeletedAt && (
              <>You deleted the transcript on {formatDate(m.transcriptDeletedAt)}. </>
            )}
            What is below is what was kept.
          </span>
        </p>
      )}

      {/* Processing / failed */}
      {!terminal && (
        <ProcessingCard
          status={status}
          progress={live?.progress ?? statusProgress(status)}
          message={live?.message}
          onStop={stoppable ? () => void stopProcessing() : undefined}
          stopping={recordingJob.stopping}
        />
      )}
      {failed && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
            <div>
              <p className="font-medium">Processing failed</p>
              <p className="text-sm text-muted-foreground">{m.errorMessage || "Try reprocessing the meeting."}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {ready && (
        /*
         * Two columns and two tabs, where there were four tabs and one column.
         *
         * Ask and Action items are not places, and making them tabs meant the
         * two things you do *while* reading — question it, and see what you
         * agreed to — were both somewhere the reading was not. The chat is now
         * a rail that stays put, and the action items sit under the summary
         * they were extracted from.
         */
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <Tabs value={tab} onValueChange={changeTab} className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b">
            <TabsList variant="underline" className="flex gap-x-6 border-b-0">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>

            {/* On the tab row rather than inside the summary card, because it
                governs the whole document below it rather than any one section
                of it. Only on Summary: it rewrites the brief, and offering it
                over a transcript it cannot change would be a control that does
                nothing to what is on screen. */}
            {tab === "summary" && (
              <TemplatePicker meetingId={id} current={summary.data?.templateSlug ?? "general"} />
            )}

            {/* The transcript's counterpart to the template picker, in the same
                place for the same reason: it is a mode over the whole document
                below, not a control on any one line of it.

                Only over the original. A translated transcript is derived
                text — correcting it would edit a copy nothing else reads,
                leave the words it was translated from untouched, and be
                overwritten the next time the translation was refreshed. */}
            {tab === "transcript" && !showing && (transcript.data?.segments?.length ?? 0) > 0 && (
              editingTranscript ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={editStatus.saving}
                    onClick={() => transcriptEditor.current?.cancel()}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={editStatus.saving}
                    onClick={() => void transcriptEditor.current?.save()}
                  >
                    {editStatus.saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    Done
                    {editStatus.dirty > 0 ? ` (${editStatus.dirty})` : ""}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setEditingTranscript(true)}>
                  <Pencil className="h-4 w-4" /> Edit Transcript
                </Button>
              )
            )}
          </div>

          {/* Summary + translation */}
          <TabsContent value="summary" className="space-y-4 pt-4">
            <SummaryPanel
              meetingId={id}
              loading={summary.isLoading}
              summary={summary.data}
              translation={showing}
              onSeek={playFrom}
            />
            {/* Directly under the brief, and above Decisions and Risks.
                What a meeting asks of you is the part with consequences, and
                it was sitting third — below two cards that are commentary on
                what happened. Somebody scanning a summary for what they now
                have to do had to scroll past both to find out.

                Titled, because it is now one section of a document rather than
                the only card on the page without a name. */}
            <Card>
              <CardContent className="space-y-3 pt-6">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <ListChecks className="h-4 w-4" /> Action items
                </h3>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    {openActions === 0
                      ? "Everything here is done."
                      : `${openActions} of ${actions.data?.length ?? 0} still open.`}
                  </p>
                  {/* Nothing here needs a transcript selection: a commitment made
                      in the room and never said aloud is exactly the one the
                      extractor cannot find. */}
                  <NewActionItemDialog meetingId={id} />
                </div>

                {actions.data && actions.data.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {actions.data.map((a) => (
                      <ActionItemRow
                        key={a.id}
                        item={a}
                        showMeeting={false}
                        // The row reads in the chosen language; the edit form
                        // inside it stays in the original, because that is the
                        // text an edit would replace.
                        translation={showing?.actionItems.find((t) => t.id === a.id)}
                        rightToLeft={showing?.rightToLeft}
                        // There is a player on this page, so the sentence plays
                        // here rather than opening the meeting again.
                        onOpenSource={playFrom}
                      />
                    ))}
                  </ul>
                ) : (
                  <EmptyText>No action items were extracted.</EmptyText>
                )}
                <Button variant="link" className="px-0" asChild>
                  <Link href="/action-items">Manage all action items →</Link>
                </Button>
              </CardContent>
            </Card>

            {/* Last, and still below the summary rather than above it: these
                rows are read out of the brief, and putting them first would
                suggest they were the source rather than the reading. */}
            <InsightsPanel meetingId={id} />
          </TabsContent>

          <TabsContent value="transcript" className="pt-4">
            {showing ? (
              showing.hasTranscript ? (
                <Card>
                  <CardContent className="pt-6">
                    <TranslatedTranscript
                      segments={transcript.data?.segments ?? []}
                      translation={showing}
                      currentTime={audio.currentTime}
                      onSeek={audio.seekTo}
                      onShowOriginal={() => void onReadIn(ORIGINAL)}
                    />
                  </CardContent>
                </Card>
              ) : (
                /* Asked for rather than done automatically. An hour of speech
                   is thousands of words: doing it for everyone who switched
                   language to read the summary would spend their money and
                   half a minute of their time on a tab they never opened. */
                <Card>
                  <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="font-medium">
                      The transcript is still in its original language.
                    </p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Translating every utterance takes longer than the summary
                      did, so it is done on request.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={translating}
                      onClick={() => void onReadIn(readingIn, true)}
                    >
                      {translating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Languages className="h-4 w-4" />
                      )}
                      Translate the transcript into {showing.languageName}
                    </Button>
                  </CardContent>
                </Card>
              )
            ) : editingTranscript ? (
              <TranscriptEditor
                ref={transcriptEditor}
                meetingId={id}
                segments={transcript.data?.segments ?? []}
                onStatus={onEditStatus}
                onClose={leaveEditing}
              />
            ) : (
            <TranscriptPanel
              meetingId={id}
              loading={transcript.isLoading}
              segments={transcript.data?.segments ?? []}
              speakerStats={transcript.data?.speakers ?? []}
              fallbackText={transcript.data?.transcript}
              currentTime={audio.currentTime}
              // Passed straight through rather than wrapped in a closure:
              // `seekTo` is a stable useCallback, and a fresh arrow here would
              // change identity 60 times a second, defeating the memo that
              // keeps inactive utterances from re-rendering every frame.
              onSeek={audio.seekTo}
              onAskAbout={askAbout}
              openSpeakers={speakerTools}
            />
            )}
          </TabsContent>
        </Tabs>

        {/* The rail. Sticky, because its whole purpose is to stay beside the
            thing being read — a chat that scrolls away with the transcript is
            the tab it replaced. */}
        <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:w-[22rem] xl:w-[26rem] no-print">
          <MeetingRail
            meetingId={id}
            showOutline={tab === "transcript"}
            sections={showing?.sections ?? summary.data?.sections ?? []}
            suggestions={summary.data?.suggestions}
            composed={composed}
            // Through the switch, not straight to the player: this rail is
            // beside both tabs, so a chat citation can be clicked while the
            // brief is on screen and the player does not exist yet.
            onSeek={playFrom}
          />
        </aside>
        </div>
      )}

      {/* Opened from the ⋯ menu, mounted here. A dialog inside a Radix menu is
          unmounted in the same frame the menu closes, which is the same reason
          the export one lives on the page. */}
      <TranslationDialog
        open={pickingLanguage}
        onOpenChange={setPickingLanguage}
        sourceLanguage={m.language}
        value={readingIn}
        onChange={(v) => void onReadIn(v)}
        available={availableTranslations.data}
        busy={translating}
      />
    </div>
  );
}

/* -------------------------------- The rail ------------------------------- */

/**
 * What sits beside the document: the chat, and — over the transcript — a way
 * around it.
 *
 * The Outline tab is only offered against the transcript, and that is the point
 * of it. Over the summary the outline is already on screen, in full, a few
 * inches to the left; repeating it in a narrower column would be the same list
 * twice. Over the transcript it is the only thing that makes an hour of speech
 * navigable, because a transcript has no headings of its own.
 */
function MeetingRail({
  meetingId,
  showOutline,
  sections,
  suggestions,
  composed,
  onSeek,
}: {
  meetingId: string;
  showOutline: boolean;
  sections: SummarySection[];
  suggestions?: string[];
  composed: { text: string; send: boolean; nonce: number } | null;
  onSeek: (seconds: number) => void;
}) {
  const [pane, setPane] = React.useState("chat");

  // Falling back rather than stranding the reader on an empty tab: leaving the
  // transcript takes the outline with it, and a rail showing nothing would look
  // broken rather than finished.
  React.useEffect(() => {
    if (!showOutline && pane === "outline") setPane("chat");
  }, [showOutline, pane]);

  return (
    <Tabs value={pane} onValueChange={setPane}>
      <TabsList variant="underline" className="flex gap-x-6">
        <TabsTrigger value="chat">
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> AI Chat
        </TabsTrigger>
        {showOutline && <TabsTrigger value="outline">Outline</TabsTrigger>}
      </TabsList>

      <TabsContent value="chat" className="pt-4">
        <ChatPanel
          meetingId={meetingId}
          onCite={onSeek}
          suggestions={suggestions}
          composed={composed}
        />
      </TabsContent>

      {showOutline && (
        <TabsContent value="outline" className="pt-4">
          <OutlineNav sections={sections} onSeek={onSeek} />
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * Which template wrote the summary, and a way to have it rewritten.
 *
 * Its own component with its own mutation, rather than a prop drilled through
 * the summary card, because it now sits on the tab row — outside the card
 * entirely — and the card still has a second use for the same call in its
 * "the transcript changed" banner.
 */
function TemplatePicker({ meetingId, current }: { meetingId: string; current: string }) {
  const { data: templates } = useGetSummaryTemplatesQuery();
  const [resummarize, { isLoading: rewriting }] = useResummarizeMutation();

  if (!templates || templates.length === 0) return null;

  async function onChange(slug: string) {
    try {
      await resummarize({ id: meetingId, template: slug }).unwrap();
      toast.success("Summary rewritten.");
    } catch {
      toast.error("Could not rewrite the summary.");
    }
  }

  return (
    <div className="flex items-center gap-2 pb-2 no-print">
      <span className="text-sm text-muted-foreground">Template:</span>
      <Select value={current} onValueChange={onChange} disabled={rewriting}>
        <SelectTrigger className="h-8 w-[170px]">
          {rewriting ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Rewriting...
            </span>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          {templates.map((t) => (
            <SelectItem key={t.slug} value={t.slug}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ----------------------------- Summary panel ----------------------------- */

/**
 * One section, drawn by its `kind`.
 *
 * The switch is on `kind` rather than on which arrays are non-empty, so an
 * empty section still renders its heading. That is the point: "Budget" with
 * nothing under it tells the reader budget never came up, which is a finding.
 * Inferring the shape from the data would silently hide it.
 */
function SummarySectionView({
  section,
  onSeek,
}: {
  section: SummarySection;
  onSeek: (seconds: number) => void;
}) {
  const empty =
    !section.text?.trim() &&
    section.bullets.length === 0 &&
    section.groups.length === 0;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold tracking-tight">{section.title}</h3>

      {empty ? (
        <p className="text-sm italic text-muted-foreground">Not discussed.</p>
      ) : section.kind === "prose" ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {section.text}
        </p>
      ) : section.kind === "bullets" ? (
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {section.bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-4">
          {section.groups.map((g, i) => (
            <div key={i}>
              {/*
               * A heading is a link to the moment its topic began — but only
               * when the ai-service could actually find that moment. The rest
               * stay plain text.
               *
               * The alternative, making every heading clickable and sending the
               * unanchored ones to 0:00 or to a guess, is worse than it looks:
               * a link that lands on the wrong minute is indistinguishable from
               * a transcript that disagrees with its own summary, and the
               * reader has no way to tell which of the two is broken.
               */}
              {g.startSeconds != null ? (
                <button
                  type="button"
                  onClick={() => onSeek(g.startSeconds as number)}
                  title={`Play from ${timecode(g.startSeconds)}`}
                  className="group mb-1.5 flex items-baseline gap-2 text-left"
                >
                  <span className="text-sm font-medium group-hover:underline">{g.heading}</span>
                  <span className="tabular font-mono text-xs text-muted-foreground">
                    {timecode(g.startSeconds)}
                  </span>
                </button>
              ) : (
                <h4 className="mb-1.5 text-sm font-medium">{g.heading}</h4>
              )}
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {g.bullets.map((b, j) => (
                  <li key={j} className="flex gap-2">
                    <span aria-hidden className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryPanel({
  meetingId,
  loading,
  summary,
  translation,
  onSeek,
}: {
  meetingId: string;
  loading: boolean;
  summary?: SummaryResponse;
  /** The brief in the reading language, when one has been chosen. */
  translation?: MeetingTranslation;
  /** Plays from a quotation's moment. Shared with the transcript and chat. */
  onSeek: (seconds: number) => void;
}) {
  // The picker itself lives on the tab row now (see TemplatePicker). This call
  // stays because the "the transcript changed" banner below rewrites with the
  // template already in use, which is the same request without the choosing.
  const [resummarize, { isLoading: rewriting }] = useResummarizeMutation();
  const translated = translation;

  async function onTemplateChange(slug: string) {
    try {
      await resummarize({ id: meetingId, template: slug }).unwrap();
      toast.success("Summary rewritten.");
    } catch {
      toast.error("Could not rewrite the summary.");
    }
  }

  const view = translated ?? summary;
  // The translation carries the sections too, so the translated brief is the
  // same document in another language rather than a thinner one — which is
  // what it used to be, and what made switching language quietly show the
  // reader less of the meeting than staying in English did.
  //
  // Memoised because the topics below are derived from it: a fresh array
  // identity on every render would recompute them on every render, which is
  // cheap here and exactly the habit that stops being cheap later.
  const sections = React.useMemo(
    () => translated?.sections ?? summary?.sections ?? [],
    [translated, summary?.sections],
  );
  // Hidden alongside the sections while a translation is showing: a quotation is
  // a claim about the exact words spoken, so displaying it beside translated
  // prose would invite reading it as a translated quote.
  const quotes = translated ? [] : summary?.quotes ?? [];
  /**
   * The topics covered, taken from the outline's headings.
   *
   * Every template ends with an outline whose headings are the topics in the
   * order they came up, so this is a read of something already generated rather
   * than a second opinion about it. Empty for summaries written before
   * templates existed, which have no outline to read.
   */
  const topics = React.useMemo(
    () =>
      sections
        // Keyed on `outline`, not on kind: a template may use the outline
        // *shape* for something that is not the walkthrough — Interview pairs
        // each question with its answer that way — and those headings are
        // questions, not topics the meeting covered.
        .filter((s) => s.key === "outline")
        .flatMap((s) => s.groups.map((g) => g.heading))
        .map((h) => h.trim())
        .filter(Boolean),
    [sections],
  );
  const current = summary?.templateSlug ?? "general";

  return (
    <Card>
      <CardContent
        className="space-y-6 pt-6"
        // Set from the language rather than sniffed from the characters:
        // Arabic and Hebrew laid out left-to-right are not merely ugly, they
        // are hard to read.
        dir={translated?.rightToLeft ? "rtl" : undefined}
      >
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : view ? (
          <>
            {/* The transcript has been corrected since this was written, so the
                notes and the transcript below them disagree. Not rewritten
                automatically — that would spend a model call on every typo fix,
                and on each of the next nineteen — so the choice is offered
                instead of made. Hidden while a translation is showing: it
                describes the original, which isn't what's on screen. */}
            {summary?.stale && !translated && (
              <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                  The transcript changed after this summary was written.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTemplateChange(current)}
                  disabled={rewriting}
                >
                  {rewriting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Rewrite it
                </Button>
              </div>
            )}

            {sections.length > 0 ? (
              <div className="space-y-6">
                {/* What was covered, at a glance.
                    Derived from the outline's headings rather than generated
                    separately. Asking the model for a second list of topics
                    would cost another section and — worse — could disagree with
                    the outline, leaving two answers to "what was discussed".
                    The headings already are the topics, in the order they came
                    up; this just makes them scannable without reading the
                    walkthrough. */}
                {topics.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
                      Topics discussed
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {topics.map((t, i) => (
                        <span
                          key={i}
                          className="rounded-full border bg-muted/50 px-2.5 py-1 text-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {sections.map((s) => (
                  <SummarySectionView key={s.key} section={s} onSeek={onSeek} />
                ))}
                {/* Rendered from its own field rather than as a section: these
                    carry a speaker and a timestamp, which the section shapes
                    cannot express, and they are the one part of a brief that
                    claims to be exact — so they are shown as evidence, playable
                    at the moment they were said. Hidden entirely when nothing
                    verified, which is a normal outcome rather than a failure. */}
                {quotes.length > 0 && (
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                      <Quote className="h-4 w-4" /> Key quotations
                    </h3>
                    <div className="space-y-2">
                      {quotes.map((q, i) => (
                        <button
                          key={i}
                          onClick={() => onSeek(q.start)}
                          className="block w-full rounded-md border-l-2 border-primary/40 bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted"
                          title={`Play from ${timecode(q.start)}`}
                        >
                          <span className="block text-sm italic">“{q.text}”</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {q.speaker || "Unknown speaker"} · {timecode(q.start)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Summaries written before templates existed, which have no
                 sections to lay out. A translation carries them, so it takes
                 the branch above. */
              <>
                <p className="text-base">{view.shortSummary}</p>
                {view.keyPoints.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Key points</h3>
                    <ul className="list-inside list-disc space-y-1 text-sm">
                      {view.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
                    </ul>
                  </div>
                )}
                {view.detailedSummary && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Detailed summary</h3>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{view.detailedSummary}</p>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <EmptyText>No summary available.</EmptyText>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------- Chat panel ------------------------------ */
function ChatPanel({
  meetingId,
  onCite,
  suggestions,
  composed,
}: {
  meetingId: string;
  onCite: (s: number) => void;
  /**
   * Questions generated from this meeting's summary. Passed down rather than
   * fetched here: the page already has the summary, and a second request would
   * make the chips appear after the chat they sit above.
   */
  suggestions?: string[];
  /** A question pushed in from the transcript's selection menu. */
  composed?: { text: string; send: boolean; nonce: number } | null;
}) {
  // Null means "whatever I was last saying about this meeting", which is what
  // the server returns for an unspecified conversation — so a first visit needs
  // no conversation to exist.
  // Scoped to this meeting and empty on load, so opening one offers a clean
  // sheet rather than the conversation you had about it last week. Outside
  // component state so that switching to the transcript tab and back does not
  // abandon a thread mid-question.
  const [conversationId, setConversationId] = useActiveChat(meetingId);

  const {
    data: messages,
    isLoading,
    isError: chatError,
    // Skipped until a thread is named: history without one returns the most
    // recent conversation, which is what used to resume an old chat on open.
  } = useGetChatQuery(
    { id: meetingId, conversationId: conversationId ?? undefined },
    { skip: !conversationId },
  );
  const { data: conversations } = useGetMeetingConversationsQuery(meetingId);
  const [ask, { isLoading: asking }] = useAskChatMutation();
  const [newConversation, { isLoading: starting }] = useCreateMeetingConversationMutation();
  const [rename] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();
  const [q, setQ] = React.useState("");
  const threadRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  /**
   * Keep the newest exchange in view — inside the thread, and nowhere else.
   *
   * This used to call `scrollIntoView` on a sentinel at the end of the list,
   * which scrolls *every* scrollable ancestor, the document included. So
   * opening a meeting scrolled the whole page down to the bottom of the chat
   * panel the moment its history arrived, and the summary — the thing somebody
   * opened the meeting to read — started off screen.
   *
   * Setting `scrollTop` on the thread's own container cannot reach the window.
   */
  React.useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
  }, [messages, asking]);

  /**
   * Recover from a conversation that is no longer there — see the same guard on
   * the workspace chat. Without it a thread deleted underneath this page leaves
   * the chat stuck on 404 with no way out but a reload.
   */
  React.useEffect(() => {
    if (chatError && conversationId) setConversationId(null);
  }, [chatError, conversationId]);

  const submitRef = React.useRef<(text: string) => Promise<void>>();

  /**
   * Take whatever the transcript handed over.
   *
   * Keyed on the nonce alone: the same passage can be asked about twice, and
   * depending on the text would silently swallow the second attempt. A complete
   * prompt is sent; an opening is placed in the box with the caret at the end,
   * because it is missing the only thing the app cannot supply — the question.
   */
  React.useEffect(() => {
    if (!composed) return;
    if (composed.send) {
      void submitRef.current?.(composed.text);
      return;
    }
    setQ(composed.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(composed.text.length, composed.text.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed?.nonce]);

  async function submit(text: string) {
    const question = text.trim();
    if (!question) return;
    setQ("");
    try {
      // Its own thread when none is named, rather than being appended to the
      // last one. The server's rule for an unnamed ask is "continue the most
      // recent, or start one", so a clean sheet on screen would otherwise file
      // the question into a conversation it is not showing.
      const target = conversationId ?? (await newConversation(meetingId).unwrap()).id;
      const answer = await ask({
        id: meetingId,
        question,
        conversationId: target,
      }).unwrap();
      setConversationId(answer.conversationId);
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }
  submitRef.current = submit;

  async function onNew() {
    try {
      const created = await newConversation(meetingId).unwrap();
      setConversationId(created.id);
      setQ("");
    } catch {
      toast.error("Couldn't start a new chat.");
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    await submit(q);
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" /> Ask this meeting
        </CardTitle>
        <ChatHistory
          conversations={conversations ?? []}
          activeId={conversationId}
          // Same rule as the workspace chat: an empty thread has nothing to
          // start. See `isNew` in lib/use-workspace-chat.
          atNewChat={!isLoading && (messages?.length ?? 0) === 0}
          onSelect={setConversationId}
          onNew={onNew}
          busy={starting}
          onRename={async (id, title) => {
            await rename({ conversationId: id, title, scope: meetingId }).unwrap();
          }}
          onDelete={async (id) => {
            await removeConversation({ conversationId: id, scope: meetingId }).unwrap();
            // The open thread just went; fall back to the most recent one.
            if (id === conversationId) setConversationId(null);
          }}
        />
      </CardHeader>
      <CardContent>
        <div ref={threadRef} className="mb-4 max-h-[420px] space-y-4 overflow-y-auto">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : messages && messages.length > 0 ? (
            messages.map((msg) => (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                deleting={deleting}
                onDelete={async (messageId) => {
                  const result = await deleteExchange({ messageId, scope: meetingId }).unwrap();
                  // That was the thread's only exchange, so the thread went
                  // with it. Holding its id would 404 every read from here.
                  if (result.conversationDeleted) setConversationId(null);
                }}
              >
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {msg.citations.map((c, i) =>
                      c.start != null ? (
                        <button
                          key={i}
                          onClick={() => onCite(c.start as number)}
                          title={c.text}
                          className="inline-flex items-center gap-1 rounded-full bg-background/60 px-2 py-0.5 text-[11px] text-foreground hover:bg-background"
                        >
                          <Quote className="h-3 w-3" /> {timecode(c.start as number)}
                        </button>
                      ) : null
                    )}
                  </div>
                )}
              </ChatMessageBubble>
            ))
          ) : (
            // Nothing in the thread. The starter prompts sit above the
            // composer instead, so the panel reads bottom-up rather than
            // opening with a wall of chips where the first answer will appear.
            null
          )}
          {asking && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="inline h-4 w-4 animate-spin" /> Searching the transcript…
              </div>
            </div>
          )}
        </div>

        {!isLoading && (messages?.length ?? 0) === 0 && (
          <div className="mb-3">
            <ChatSuggestions
              prompts={toPrompts(suggestions, MEETING_PROMPTS)}
              disabled={asking}
              onSend={(prompt) => void submit(prompt)}
              onCompose={setQ}
            />
          </div>
        )}

        <form onSubmit={send} className="flex gap-2">
          <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this meeting…" disabled={asking} />
          <Button type="submit" size="icon" disabled={asking || !q.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ---------------------------- Transcript panel --------------------------- */
function TranscriptPanel({
  meetingId,
  loading,
  segments,
  speakerStats,
  fallbackText,
  currentTime,
  onSeek,
  onAskAbout,
  openSpeakers,
}: {
  meetingId: string;
  loading: boolean;
  segments: TranscriptSegment[];
  /**
   * Talk-time as the server computed it. Preferred over recomputing here so
   * the figures in the UI, the API and an export cannot disagree; the local
   * fallback below covers a cached response from before this field existed.
   */
  speakerStats: SpeakerStats[];
  fallbackText?: string;
  currentTime: number;
  onSeek: (s: number) => void;
  /** Hands a selected passage to the chat on the Ask tab. */
  onAskAbout: (text: string, send: boolean) => void;
  /**
   * Bumped by "Rematch speakers" on the meeting menu.
   *
   * The tools were already here and findable only by scrolling to the talk-time
   * block and noticing a ghost button — which is to say, not findable. A
   * counter rather than a boolean because the item has to work on the second
   * press as well as the first.
   */
  openSpeakers: number;
}) {
  const speakerTools = React.useRef<HTMLDivElement | null>(null);
  const [renameSpeakers, { isLoading: renaming }] = useRenameSpeakersMutation();
  const [rematchSpeaker, { isLoading: merging }] = useRematchSpeakerMutation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  // Which label the user is folding away, and into whom.
  const [mergeFrom, setMergeFrom] = React.useState("");
  const [mergeInto, setMergeInto] = React.useState("");

  // Names this user has used before. Offered as autocomplete rather than a
  // forced choice: a new person in the meeting must not be harder to name than
  // a familiar one.
  const knownSpeakers = useGetKnownSpeakersQuery();

  const [editSegments, { isLoading: savingText }] = useEditSegmentsMutation();
  // Which line is open for editing, and the text as typed. Held by segment id
  // rather than index so a refetch that reorders nothing still cannot move the
  // edit onto a different line.
  const [openLine, setOpenLine] = React.useState<string | null>(null);
  const [lineDraft, setLineDraft] = React.useState("");

  function beginEdit(segment: TranscriptSegment) {
    if (!segment.id) return;
    setOpenLine(segment.id);
    setLineDraft(segment.text);
  }

  async function saveLine(original: string) {
    const text = lineDraft.trim();
    if (!openLine || !text || text === original) {
      setOpenLine(null);
      return;
    }
    try {
      await editSegments({ id: meetingId, edits: [{ id: openLine, text }] }).unwrap();
      // Deliberately quiet about the summary: it was written from the old
      // wording and is now slightly stale, which is the user's call to fix.
      toast.success("Transcript updated.");
      setOpenLine(null);
    } catch {
      toast.error("Could not save that correction.");
    }
  }

  // Skips the first render: the panel mounts with a nonce of zero, and opening
  // the speaker tools for somebody who merely opened the Transcript tab would
  // put an editing form over what they came to read.
  React.useEffect(() => {
    if (openSpeakers === 0) return;
    setEditing(true);
    speakerTools.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [openSpeakers]);

  const speakers = React.useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => s.speaker && set.add(s.speaker));
    return Array.from(set);
  }, [segments]);

  /**
   * Talk-time, server-computed where available.
   *
   * The local sum is kept only as a fallback for a cached transcript fetched
   * before the server returned these — two independent implementations of the
   * same percentage is exactly how the number in the UI ends up disagreeing
   * with the number in an export.
   */
  const talk = React.useMemo(() => {
    if (speakerStats.length > 0) {
      const map = new Map<string, number>();
      let total = 0;
      for (const stat of speakerStats) {
        map.set(stat.speaker, stat.speakingSeconds);
        total += stat.speakingSeconds;
      }
      return { map, total };
    }
    const map = new Map<string, number>();
    let total = 0;
    for (const s of segments) {
      const d = Math.max(0, (s.end || 0) - (s.start || 0));
      map.set(s.speaker, (map.get(s.speaker) || 0) + d);
      total += d;
    }
    return { map, total };
  }, [segments, speakerStats]);

  const allTurns = React.useMemo(() => groupIntoTurns(segments), [segments]);

  /* ---- Marking: highlights, bookmarks and notes ---- */
  const { data: moments } = useGetMomentsQuery(meetingId);
  const marks = React.useMemo(() => moments ?? [], [moments]);
  const [createMoment, { isLoading: marking }] = useCreateMomentMutation();
  const [deleteMoment] = useDeleteMomentMutation();

  // The live selection, plus where to put the menu. Held together because a
  // menu without a selection is a menu whose actions do nothing.
  const [picked, setPicked] = React.useState<{
    capture: SelectionCapture;
    anchor: { top: number; left: number; bottom: number };
  } | null>(null);
  const [noteFor, setNoteFor] = React.useState<Passage | null>(null);
  const [actionFor, setActionFor] = React.useState<Passage | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  const clearSelection = React.useCallback(() => {
    setPicked(null);
    window.getSelection?.()?.removeAllRanges();
  }, []);

  /**
   * Watch for a finished selection.
   *
   * On mouseup and keyup rather than on `selectionchange`: the latter fires
   * continuously while dragging, so the menu would appear over the words being
   * selected and move under the cursor. Mousedown clears, so a click anywhere
   * dismisses — the menu stops its own mousedown from reaching here.
   */
  React.useEffect(() => {
    function capture() {
      const found = readSelection(bodyRef.current);
      if (!found) {
        setPicked(null);
        return;
      }
      const range = window.getSelection()?.getRangeAt(0);
      const rect = range?.getBoundingClientRect();
      if (!rect) {
        setPicked(null);
        return;
      }
      setPicked({
        capture: found,
        anchor: { top: rect.top, left: rect.left, bottom: rect.bottom },
      });
    }
    function dismiss() {
      setPicked(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }

    document.addEventListener("mouseup", capture);
    document.addEventListener("keyup", capture);
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mouseup", capture);
      document.removeEventListener("keyup", capture);
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function saveMoment(kind: "HIGHLIGHT" | "BOOKMARK", p: Passage) {
    try {
      await createMoment({
        meetingId,
        body: {
          kind,
          ranges: p.ranges,
          quote: p.quote,
          body: "",
          speaker: p.speaker,
          startSeconds: p.startSeconds,
          endSeconds: p.endSeconds,
        },
      }).unwrap();
    } catch {
      toast.error("Could not save that mark.");
    }
  }

  async function copyToClipboard(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(ok);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  async function onSelectionAction(action: SelectionAction) {
    if (!picked) return;
    const p = picked.capture;

    switch (action) {
      case "highlight":
        await saveMoment("HIGHLIGHT", p);
        break;
      case "copy":
        // With the speaker and the timecode, because a transcript line pasted
        // bare into a ticket loses the two things that make it evidence.
        await copyToClipboard(attributedQuote(p), "Copied with attribution.");
        break;
      case "note":
        setNoteFor(p);
        break;
      case "ask":
        // Left unfinished: only the user knows what they wanted to ask.
        onAskAbout(askPrefix(p.quote), false);
        break;
      case "summarize":
        onAskAbout(summarizePrompt(p.quote), true);
        break;
      case "action-item":
        setActionFor(p);
        break;
      case "share": {
        // The in-app deep link, which the page already knows how to open at a
        // timestamp. Not the public share link: that is a separate capability
        // URL the owner may not have created, and minting one silently from a
        // menu would publish a meeting nobody asked to publish.
        const url = `${window.location.origin}/meetings/${meetingId}?t=${Math.floor(p.startSeconds)}`;
        await copyToClipboard(url, "Link copied — it opens at this moment.");
        break;
      }
    }
    clearSelection();
  }

  /** The bookmark on a turn, if there is one. */
  function bookmarkAt(seconds: number): TranscriptMoment | undefined {
    return marks.find(
      (m) => m.kind === "BOOKMARK" && Math.abs(m.startSeconds - seconds) < 0.01,
    );
  }

  /**
   * The marks anchored to a turn rather than to a passage inside it.
   *
   * Matched on the exact start, which is how a bookmark has always been found:
   * two turns never share one, and a tolerance wide enough to be forgiving is
   * wide enough to attach a reaction to the wrong sentence.
   */
  function turnMarks(kind: MomentKind, seconds: number): TranscriptMoment[] {
    return marks.filter(
      (m) =>
        m.kind === kind &&
        m.ranges.length === 0 &&
        Math.abs(m.startSeconds - seconds) < 0.01,
    );
  }

  /** Every word of a turn, as one string — what Copy puts on the clipboard. */
  function turnText(turn: Turn): string {
    return turn.segments.map((s) => s.text).join(" ").trim();
  }

  /**
   * What a turn-level mark is about.
   *
   * No ranges, deliberately. A note on a whole turn is about what somebody
   * said, not about a span of characters — and giving it ranges covering every
   * word would paint the entire paragraph in highlighter, which is the styling
   * that means "I marked these exact words".
   */
  function turnPassage(turn: Turn): Passage {
    const last = turn.segments[turn.segments.length - 1];
    return {
      ranges: [],
      quote: turnText(turn),
      speaker: turn.speaker,
      startSeconds: turn.start,
      endSeconds: last ? last.end : turn.start,
    };
  }

  /**
   * Add the emoji, or take it off if it is already there.
   *
   * A toggle rather than an add, because the gesture that costs one click has
   * to cost one click to undo. The server treats a repeat as a no-op, so a
   * double click that races itself cannot leave two of the same reaction on one
   * turn.
   */
  async function toggleReaction(turn: Turn, emoji: string) {
    const existing = turnMarks("REACTION", turn.start).find((m) => m.body === emoji);
    try {
      if (existing) {
        await deleteMoment({ id: existing.id, meetingId }).unwrap();
        return;
      }
      await createMoment({
        meetingId,
        body: {
          kind: "REACTION",
          ranges: [],
          // Context for the marks list, which shows reactions beside notes and
          // bookmarks and would otherwise list an emoji against nothing.
          quote: turnText(turn).slice(0, 200),
          body: emoji,
          speaker: turn.speaker,
          startSeconds: turn.start,
          endSeconds: turn.start,
        },
      }).unwrap();
    } catch {
      toast.error("Could not save that reaction.");
    }
  }

  async function toggleBookmark(turn: Turn) {
    const existing = bookmarkAt(turn.start);
    try {
      if (existing) {
        await deleteMoment({ id: existing.id, meetingId }).unwrap();
        return;
      }
      await saveMoment("BOOKMARK", {
        ranges: [],
        // A bookmark marks a time, so its text is context for the list rather
        // than an anchor — the first line of the turn is what identifies it.
        quote: (turn.segments[0]?.text ?? "").slice(0, 200),
        speaker: turn.speaker,
        startSeconds: turn.start,
        endSeconds: turn.start,
      });
    } catch {
      toast.error("Could not update that bookmark.");
    }
  }

  /**
   * Find-in-transcript.
   *
   * The browser's own Ctrl-F is the obvious answer and it is not good enough
   * here: a two-hour transcript is thousands of lines, and finding the fifth
   * mention means pressing Enter five times with no idea how many there are.
   * This filters to the turns that match and says how many, so "did anyone
   * mention the migration?" is answered by looking rather than by scrolling.
   *
   * Speaker names are searched too — "what did Priya say?" is the same question
   * shaped differently.
   */
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();

  /**
   * Only the marked turns.
   *
   * The counterpart to the highlight list below: that one reads as an index,
   * this one keeps the marks in the transcript where the surrounding speech is
   * still there to be played.
   */
  const [onlyMarked, setOnlyMarked] = React.useState(false);

  /**
   * The marks each segment carries, resolved against its current text.
   *
   * Computed once for the whole transcript rather than per utterance while
   * rendering: resolution can fall back to searching a segment for the quoted
   * words, and doing that inside the render path would repeat the search on
   * every clock tick.
   */
  const marksBySegment = React.useMemo(() => {
    const map = new Map<string, SegmentMark[]>();
    if (marks.length === 0) return map;
    for (const s of segments) {
      if (!s.id) continue;
      const found = segmentMarks(s.id, s.text, marks);
      if (found.length > 0) map.set(s.id, found);
    }
    return map;
  }, [segments, marks]);

  /**
   * Marks that point at a time rather than at words: bookmarks, reactions, and
   * notes made on a whole turn.
   *
   * They have no ranges, so `marksBySegment` never sees them — which would make
   * "show only marked" hide the turn somebody just reacted to. Matched by start
   * time, the way the marks themselves are anchored.
   */
  const anchorTimes = React.useMemo(
    () => marks.filter((m) => m.ranges.length === 0).map((m) => m.startSeconds),
    [marks],
  );

  const turns = React.useMemo(() => {
    let visible = allTurns;
    if (needle) {
      visible = visible.filter(
        (t) =>
          t.speaker.toLowerCase().includes(needle) ||
          t.segments.some((s) => s.text.toLowerCase().includes(needle)),
      );
    }
    if (onlyMarked) {
      visible = visible.filter(
        (t) =>
          t.segments.some((s) => s.id && marksBySegment.has(s.id)) ||
          anchorTimes.some((at) => Math.abs(at - t.start) < 0.01),
      );
    }
    return visible;
  }, [allTurns, needle, onlyMarked, marksBySegment, anchorTimes]);

  // Counted over utterances rather than turns: a turn is a display grouping, so
  // counting those would report a number that changes with how text happens to
  // be grouped rather than with how often the word was said.
  const matchCount = React.useMemo(() => {
    if (!needle) return 0;
    return segments.filter((s) => s.text.toLowerCase().includes(needle)).length;
  }, [segments, needle]);

  async function saveNames() {
    const mapping: Record<string, string> = {};
    for (const [oldName, newName] of Object.entries(draft)) {
      if (newName && newName.trim() && newName.trim() !== oldName) mapping[oldName] = newName.trim();
    }
    if (Object.keys(mapping).length === 0) {
      setEditing(false);
      return;
    }
    try {
      await renameSpeakers({ id: meetingId, mapping }).unwrap();
      toast.success("Speakers renamed.");
      setEditing(false);
      setDraft({});
    } catch {
      toast.error("Rename failed.");
    }
  }

  /**
   * Fold one diarization label into another.
   *
   * Renaming both to the same name would leave the turns separate, so the
   * transcript reads as though the person keeps interrupting themselves. This
   * merges them into one speaker.
   */
  async function mergeSpeakers() {
    if (!mergeFrom || !mergeInto || mergeFrom === mergeInto) return;
    try {
      await rematchSpeaker({
        id: meetingId,
        fromSpeaker: mergeFrom,
        toSpeaker: mergeInto,
      }).unwrap();
      toast.success(`${mergeFrom} merged into ${mergeInto}.`);
      setMergeFrom("");
      setMergeInto("");
    } catch {
      toast.error("Could not merge those speakers.");
    }
  }

  /** Move a single mis-attributed turn to whoever actually said it. */
  async function reassignTurn(segmentIds: string[], toSpeaker: string) {
    if (segmentIds.length === 0 || !toSpeaker) return;
    try {
      await rematchSpeaker({ id: meetingId, toSpeaker, segmentIds }).unwrap();
      toast.success(`Reassigned to ${toSpeaker}.`);
    } catch {
      toast.error("Could not reassign that turn.");
    }
  }

  if (loading) return <Card><CardContent className="pt-6"><Skeleton className="h-40 w-full" /></CardContent></Card>;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        {/* Find in transcript. Above everything else because it changes what
            the rest of the panel shows. */}
        {segments.length > 0 && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 pl-8 pr-8"
                placeholder="Find in transcript…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                aria-label="Find in transcript"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {needle && (
              <p className="text-xs text-muted-foreground">
                {matchCount === 0
                  ? "No matches."
                  : `${matchCount} ${matchCount === 1 ? "match" : "matches"} in ${turns.length} ${
                      turns.length === 1 ? "turn" : "turns"
                    }. Click any word to play from there.`}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Select any part of the transcript to highlight, quote, note or act
              on it. Point at a turn for reactions, notes, copying and links.
            </p>
          </div>
        )}

        {/* What has been marked. Collapsed by default: it is an index, and an
            index that opens over the thing it indexes is in the way. */}
        {marks.length > 0 && (
          <MarksSection
            meetingId={meetingId}
            moments={marks}
            segments={segments}
            onSeek={onSeek}
            onlyMarked={onlyMarked}
            onToggleFilter={() => setOnlyMarked((v) => !v)}
          />
        )}

        {/* Talk-time */}
        {speakers.length > 0 && talk.total > 0 && (
          <div className="space-y-2 scroll-mt-24" ref={speakerTools}>
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <Users className="h-4 w-4" /> Talk time
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Rename speakers"}
              </Button>
            </div>
            {editing ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  {speakers.map((sp) => (
                    <div key={sp} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-sm text-muted-foreground">{sp}</span>
                      <Input
                        className="h-8"
                        placeholder="New name"
                        // A plain datalist rather than a combobox: the field
                        // still accepts anything typed, so someone new to this
                        // workspace is no harder to name than a regular.
                        list="recallix-known-speakers"
                        value={draft[sp] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [sp]: e.target.value }))}
                      />
                    </div>
                  ))}
                  <datalist id="recallix-known-speakers">
                    {(knownSpeakers.data ?? []).map((k) => (
                      <option key={k.id} value={k.displayName} />
                    ))}
                  </datalist>
                  <Button size="sm" onClick={saveNames} disabled={renaming}>
                    {renaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
                  </Button>
                </div>

                {/* Merging is a different repair from renaming: this one is for
                    when diarization split a single person across two labels,
                    which renaming both cannot fix. */}
                {speakers.length > 1 && (
                  <div className="space-y-2 border-t pt-3">
                    <p className="text-sm font-medium">Same person twice?</p>
                    <p className="text-xs text-muted-foreground">
                      Merge one label into another when the transcriber split one
                      voice across two speakers.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={mergeFrom}
                        onChange={(e) => setMergeFrom(e.target.value)}
                      >
                        <option value="">Merge…</option>
                        {speakers.map((sp) => (
                          <option key={sp} value={sp}>{sp}</option>
                        ))}
                      </select>
                      <span className="text-sm text-muted-foreground">into</span>
                      <select
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={mergeInto}
                        onChange={(e) => setMergeInto(e.target.value)}
                      >
                        <option value="">Choose…</option>
                        {speakers
                          .filter((sp) => sp !== mergeFrom)
                          .map((sp) => (
                            <option key={sp} value={sp}>{sp}</option>
                          ))}
                      </select>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={mergeSpeakers}
                        disabled={merging || !mergeFrom || !mergeInto}
                      >
                        {merging ? <Loader2 className="h-4 w-4 animate-spin" /> : "Merge"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* One-line roll-call, ordered by who spoke most. The bars
                    below give the detail; this answers "who was in this and
                    who dominated it" at a glance. */}
                <p className="pb-1 text-sm text-muted-foreground">
                  {speakers
                    .map((sp) => ({ sp, pct: Math.round(((talk.map.get(sp) || 0) / talk.total) * 100) }))
                    .sort((a, b) => b.pct - a.pct)
                    .map(({ sp, pct }) => `${sp} (${pct}%)`)
                    .join(", ")}
                </p>
                {speakers.map((sp) => {
                  const secs = talk.map.get(sp) || 0;
                  const pct = Math.round((secs / talk.total) * 100);
                  return (
                    <div key={sp} className="flex items-center gap-3 text-sm">
                      <span className="w-20 shrink-0 truncate font-medium">{sp}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                        {pct}% · {formatDuration(Math.round(secs))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Transcript, grouped into turns.
            Diarization emits an utterance per pause, so one person speaking for
            a minute arrives as several segments. Rendered one row each, that
            reads as a stack of fragments with the same name repeated down the
            page; merged into a turn it reads as someone talking. Each utterance
            stays individually seekable inside the turn, so nothing is lost. */}
        {segments.length > 0 ? (
          <div className="space-y-5" ref={bodyRef}>
            {turns.map((turn, i) => {
              const bookmarked = bookmarkAt(turn.start);
              const reactions = turnMarks("REACTION", turn.start);
              const notes = turnMarks("NOTE", turn.start);
              return (
              <div key={i} className="group relative flex gap-3">
                {/* Floating over the top-right of the turn, out of the reading
                    column entirely: five icons inline would push the speaker's
                    name and timestamp around every time the pointer moved. */}
                <TurnActions
                  context={`${turn.speaker} at ${timecode(turn.start)}`}
                  reactions={reactions.map((m) => m.body)}
                  bookmarked={Boolean(bookmarked)}
                  busy={marking}
                  onReact={(emoji) => void toggleReaction(turn, emoji)}
                  onBookmark={() => void toggleBookmark(turn)}
                  onComment={() => setNoteFor(turnPassage(turn))}
                  onCopy={() =>
                    void copyToClipboard(
                      attributedQuote({
                        speaker: turn.speaker,
                        startSeconds: turn.start,
                        quote: turnText(turn),
                      }),
                      "Copied with attribution.",
                    )
                  }
                  onShare={() =>
                    void copyToClipboard(
                      `${window.location.origin}/meetings/${meetingId}?t=${Math.floor(turn.start)}`,
                      "Link copied — it opens at this moment.",
                    )
                  }
                />
                <SpeakerAvatar name={turn.speaker} speakerKey={turn.speakerKey} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{turn.speaker}</span>
                    <button
                      onClick={() => onSeek(turn.start)}
                      className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                      aria-label={`Play from ${timecode(turn.start)}`}
                    >
                      {timecode(turn.start)}
                    </button>
                    {/* Setting a bookmark is a toolbar action now, but a
                        bookmark that was only visible on hover would be
                        findable by scrolling only if you scrolled with the
                        pointer over every turn. So a set one stays on the row,
                        and clicking it takes it off. */}
                    {bookmarked && (
                      <button
                        onClick={() => void toggleBookmark(turn)}
                        aria-label="Remove bookmark"
                        aria-pressed
                        title="Remove bookmark"
                        className="rounded p-0.5 text-primary hover:text-foreground"
                      >
                        <Bookmark className="h-3.5 w-3.5 fill-current" />
                      </button>
                    )}
                    {/* Per-turn reassignment, for the handovers where two people
                        overlap and the whole turn landed on the wrong one. A
                        label-wide rename cannot express this: it would move
                        every other turn with it. Hidden until hover so it does
                        not compete with reading. */}
                    {speakers.length > 1 && turn.segments.some((s) => s.id) && (
                      <select
                        // Left-aligned, right beside the name it is about.
                        // The right edge of this row belongs to the floating
                        // toolbar, which would otherwise cover it on hover —
                        // the one moment it is meant to be reachable.
                        className="h-6 rounded border bg-background px-1 text-xs text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                        value=""
                        disabled={merging}
                        aria-label={`Reassign this turn from ${turn.speaker}`}
                        onChange={(e) => {
                          const to = e.target.value;
                          if (!to) return;
                          reassignTurn(
                            turn.segments.map((s) => s.id).filter((id): id is string => Boolean(id)),
                            to,
                          );
                        }}
                      >
                        <option value="">Wrong speaker?</option>
                        {speakers
                          .filter((sp) => sp !== turn.speaker)
                          .map((sp) => (
                            <option key={sp} value={sp}>Move to {sp}</option>
                          ))}
                      </select>
                    )}
                  </div>
                  <p className="text-sm leading-relaxed">
                    {turn.segments.map((s, j) => {
                      const active = currentTime >= s.start && currentTime < s.end;
                      // Editing one line replaces just that line, so the rest
                      // of the turn stays readable and still seekable while a
                      // correction is being typed.
                      if (s.id && openLine === s.id) {
                        return (
                          <span key={j} className="block py-1">
                            <textarea
                              autoFocus
                              rows={Math.max(2, Math.ceil(lineDraft.length / 70))}
                              value={lineDraft}
                              onChange={(e) => setLineDraft(e.target.value)}
                              onKeyDown={(e) => {
                                // Enter saves; Shift+Enter is a newline, and
                                // Escape abandons the edit without saving.
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  void saveLine(s.text);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  setOpenLine(null);
                                }
                              }}
                              className="w-full resize-y rounded-md border bg-background p-2 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
                            />
                            <span className="mt-1 flex items-center gap-2">
                              <Button size="sm" onClick={() => void saveLine(s.text)} disabled={savingText}>
                                {savingText ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setOpenLine(null)}>
                                Cancel
                              </Button>
                              <span className="text-xs text-muted-foreground">
                                Enter to save · Esc to cancel
                              </span>
                            </span>
                          </span>
                        );
                      }
                      return (
                        <span
                          key={j}
                          // The segment and speaker live here rather than on
                          // every word: `readSelection` recovers them with
                          // `closest`, and repeating a name across tens of
                          // thousands of spans is document weight for nothing.
                          data-seg={s.id}
                          data-speaker={turn.speaker}
                          className={cn(
                            "group/line rounded px-0.5 transition-colors",
                            active && "bg-primary/10"
                          )}
                        >
                          {/* Every utterance renders its words, not just the
                              playing one, so any word in the transcript can be
                              clicked to play from it. Inactive utterances are
                              handed a constant `at`, which lets the memo skip
                              them while the active one re-renders per frame. */}
                          <SpokenWords
                            text={s.text}
                            start={s.start}
                            end={s.end}
                            words={s.words}
                            at={active ? currentTime : -1}
                            onSeek={onSeek}
                            match={needle}
                            marks={s.id ? marksBySegment.get(s.id) : undefined}
                          />
                          {/* Only lines that differ from the meeting's language
                              carry this, so it stays a signal. In a monolingual
                              meeting nothing renders here at all. */}
                          {s.language && (
                            <span
                              className="ml-1 rounded bg-muted px-1 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                              title={`Spoken in ${languageName(s.language)}`}
                            >
                              {s.language}
                            </span>
                          )}
                          {/* Shown on hover so it never competes with reading,
                              but always reachable by keyboard. */}
                          {s.id && (
                            <button
                              onClick={() => beginEdit(s)}
                              aria-label="Correct this line"
                              title="Correct this line"
                              className="ml-0.5 rounded p-0.5 align-middle text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/line:opacity-100"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </p>

                  {/* Under the words they are about. Clicking one removes it,
                      which is the whole undo path — a gesture that costs one
                      click should not cost three to take back. */}
                  <TurnReactions
                    reactions={reactions.map((m) => m.body)}
                    onToggle={(emoji) => void toggleReaction(turn, emoji)}
                    busy={marking}
                  />

                  {/* Turn-level notes, in place. They have no ranges, so
                      nothing paints them over the transcript the way a note on
                      a selection is painted — without this they would exist
                      only in the collapsed marks list, which is a poor place to
                      keep a remark about the sentence above it. */}
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      className="mt-1 flex items-start gap-2 rounded-md border-l-2 border-primary/50 bg-muted/50 px-2 py-1.5"
                    >
                      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm">{note.body}</p>
                      <button
                        onClick={() => void deleteMoment({ id: note.id, meetingId })}
                        aria-label="Delete this note"
                        title="Delete this note"
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              );
            })}
            {/* Searched, matched nothing. Without this the panel just empties,
                which reads as a transcript that failed to load. */}
            {needle && turns.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing in this transcript matches “{query.trim()}”.
              </p>
            )}
            {!needle && onlyMarked && turns.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing is marked in this transcript yet.
              </p>
            )}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{fallbackText || "Transcript unavailable."}</p>
        )}
      </CardContent>

      <SelectionMenu anchor={picked?.anchor ?? null} onAction={onSelectionAction} busy={marking} />
      <NoteDialog meetingId={meetingId} passage={noteFor} onClose={() => setNoteFor(null)} />
      <ActionItemDialog
        meetingId={meetingId}
        passage={actionFor}
        onClose={() => setActionFor(null)}
      />
    </Card>
  );
}

/**
 * The marks on this transcript, as a collapsible index.
 *
 * Split out of {@link TranscriptPanel} only because that component is already
 * long; it has no state worth sharing beyond what is passed in.
 */
function MarksSection({
  meetingId,
  moments,
  segments,
  onSeek,
  onlyMarked,
  onToggleFilter,
}: {
  meetingId: string;
  moments: TranscriptMoment[];
  segments: TranscriptSegment[];
  onSeek: (s: number) => void;
  onlyMarked: boolean;
  onToggleFilter: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  // Looked up by id rather than scanned per mark: a two-hour transcript has
  // thousands of segments and the list resolves every mark against them.
  const textById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of segments) if (s.id) map.set(s.id, s.text);
    return map;
  }, [segments]);

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-medium"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <Highlighter className="h-4 w-4 text-amber-500" />
          {moments.length} {moments.length === 1 ? "mark" : "marks"}
        </button>
        <Button
          variant={onlyMarked ? "secondary" : "ghost"}
          size="sm"
          className="ml-auto"
          onClick={onToggleFilter}
          aria-pressed={onlyMarked}
        >
          {onlyMarked ? "Show everything" : "Show only marked"}
        </Button>
      </div>
      {open && (
        <div className="border-t px-3">
          <MomentsPanel
            meetingId={meetingId}
            moments={moments}
            segmentText={(id) => textById.get(id)}
            onSeek={onSeek}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The utterance currently being spoken, with the word at `at` highlighted and
 * every word clickable to play from it.
 *
 * Uses the provider's real per-word timings when the transcript has them.
 * Failing that it estimates, spreading the utterance's span across its words
 * in proportion to their length. The estimate assumes speech has no pauses, so
 * it runs ahead of the voice — tolerable when diarization broke utterances on
 * every pause, badly wrong when a provider groups a whole speaker turn and one
 * segment covers half a minute. Only transcripts recorded before word timings
 * were persisted take that path now.
 *
 * Memoized, and that is load-bearing rather than an optimisation. Every
 * utterance renders its words so that any of them can be clicked, which for an
 * hour-long meeting is thousands of spans. The clock ticks ~60 times a second,
 * so without the memo the whole transcript would re-render on every frame.
 * Inactive utterances are passed a constant `at`, so their props never change
 * and only the one being spoken does any work.
 */
const SpokenWords = React.memo(function SpokenWords({
  text,
  start,
  end,
  words,
  at,
  onSeek,
  match,
  marks,
}: {
  text: string;
  start: number;
  end: number;
  words?: SpokenWord[];
  at: number;
  onSeek: (t: number) => void;
  /**
   * Lower-cased search term, or empty. A word containing it is tinted, so a hit
   * is visible in place rather than only as a filtered-down list — which is
   * what tells you *why* a turn matched.
   */
  match?: string;
  /**
   * Saved highlights and notes covering this utterance, already resolved to
   * character offsets by the panel above.
   */
  marks?: SegmentMark[];
}) {
  // Tokenizing lives in lib/moments so the offsets a word reports and the ones
  // a stored highlight was saved with come from one implementation. Two would
  // drift, and a highlight that fails to resolve looks exactly like one that
  // was never saved.
  const tokens = React.useMemo(
    () => tokenize(text, start, end, words),
    [text, start, end, words],
  );

  return (
    <>
      {tokens.map((w, i) => {
        const marked = marks && marks.length > 0 ? isMarked(marks, w.from, w.to) : undefined;
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            data-word=""
            data-from={w.from}
            data-to={w.to}
            data-start={w.start}
            data-end={w.end}
            // Stops the enclosing utterance handler from also firing and seeking
            // to the start of the sentence instead of to this word.
            onClick={(e) => {
              e.stopPropagation();
              onSeek(w.start);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSeek(w.start);
              }
            }}
            title={marked?.moment.body || undefined}
            className={cn(
              "cursor-pointer rounded transition-colors duration-75 hover:bg-primary/20",
              // A saved mark and a search hit share a hue — a highlighter is
              // yellow, and pretending otherwise to avoid the collision would
              // make saved highlights unrecognisable. They are told apart by
              // the underline, which only a saved mark carries, and the overlap
              // is momentary anyway: a search tint lasts as long as the find
              // box has text in it.
              marked &&
                "rounded-none border-b-2 border-amber-500 bg-amber-400/25",
              match && w.text.toLowerCase().includes(match) &&
                "bg-amber-400/30 text-foreground",
              at >= w.start && at < w.end && "bg-primary/40 text-foreground"
            )}
          >
            {w.text}
          </span>
        );
      })}
    </>
  );
});

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
