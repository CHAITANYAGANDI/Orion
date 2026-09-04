"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  RefreshCw,
  Upload,
  Loader2,
  AlertTriangle,
  Clock,
  Sparkles,
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
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useGetChatModesQuery,
  useTranslateMeetingMutation,
  useGetTranslationsQuery,
  useGetLanguagesQuery,
  useRenameSpeakersMutation,
  useMergeSpeakersMutation,
  useReprocessMeetingMutation,
  useEditSegmentsMutation,
  useSetSegmentSpeakerMutation,
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
  isNotFoundError,
} from "@/lib/api";
import type {
  ChatMode,
  SpeakerStats,
  SpokenWord,
  MeetingTranslation,
  SummaryResponse,
  SummarySection,
} from "@/lib/types";
import { useActiveChat } from "@/lib/active-chat";
import { HeaderSlot } from "@/components/header-slot";
import { SidePane, toggleSidePaneExpanded, useSidePane } from "@/components/side-pane";
import { Button } from "@/components/ui/button";
import { useRecordingJob } from "@/lib/recording-context";
import { ProcessingCard } from "@/components/processing-card";
import {
  ProcessingSummary,
  ProcessingTranscript,
  ProcessingActionItems,
  ProcessingChatRail,
} from "@/components/processing-placeholders";
import { revealPlan } from "@/lib/processing-stages";
import {
  meetingPanels,
  meetingHas,
  meetingState,
  type PanelState,
} from "@/lib/meeting-panels";
import { trackProcessing } from "@/lib/processing-jobs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { MeetingLoadError } from "@/components/meeting-load-error";
import { ResourceLoadError } from "@/components/resource-load-error";
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
import { MeetingTitle, MeetingTags } from "@/components/meeting-title";
import { OutlineNav } from "@/components/outline-nav";
import { MeetingMenu } from "@/components/meeting-menu";
import { InsightsPanel } from "@/components/insights-panel";
import { ExportDialog } from "@/components/export-dialog";
import { copySummary, copyTranscript } from "@/lib/minutes";
import { subscribeMeetingStatus } from "@/lib/ws";
import { HOME } from "@/lib/routes";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  statusLabel,
  statusProgress,
  isTerminal,
  timecode,
} from "@/lib/format";
import { useMeetingProgress } from "@/lib/progress";
import { useAllowance, aiRefusal, reprocessCost } from "@/lib/allowance";
import { languageName } from "@/lib/language";
// Shared with the transcript editor, so reading and correcting agree about
// where the paragraphs are and the page does not reflow when you switch modes.
import { groupIntoTurns, type Turn } from "@/lib/turns";
import { SpeakerAvatar } from "@/components/speaker-avatar";
import { SpeakerEditor } from "@/components/speaker-editor";
import { TurnActions, TurnReactions } from "@/components/turn-actions";
import {
  TranscriptEditor,
  type TranscriptEditorHandle,
  type TranscriptEditorStatus,
} from "@/components/transcript-editor";
import { ChatHistory } from "@/components/chat-history";
import { ChatComposer } from "@/components/chat-composer";
import { ChatDock, ChatRail } from "@/components/chat/chat-shell";
import { ChatMessageBubble } from "@/components/chat-message";
import { PendingTurn } from "@/components/chat/pending-turn";
import { usePendingTurn, announceAnswer } from "@/lib/pending-turn";
import { useThreadScroll } from "@/lib/use-thread-scroll";
import { MEETING_PROMPTS, toPrompts } from "@/lib/chat-prompts";
import { useRotatingPrompts } from "@/lib/use-rotating-prompts";
import { SelectionMenu, type SelectionAction } from "@/components/selection-menu";
import {
  ReassignSpeakerDialog,
  type ReassignTarget,
} from "@/components/reassign-speaker-dialog";
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
  wordRangeFor,
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
   * <p>This page carries the wait for the meeting it is showing, including the
   * one control that ends it. Matched on the id: the save may still be
   * following a different meeting entirely, and offering to stop that one from
   * this page would delete something not on screen.
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
   * "Ask Reverie" about a highlighted sentence has to leave the tab it was
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
  const [reprocessMeeting, { isLoading: reprocessing }] = useReprocessMeetingMutation();
  // Keyed so the three places that can rewrite this summary share one
  // in-flight flag: this page's menu item, the template picker on the tab row,
  // and the "transcript changed" banner. Without it each knows only about its
  // own call, and the menu would start a second rewrite on top of the picker's.
  const [resummarize, { isLoading: regenerating }] = useResummarizeMutation({
    fixedCacheKey: `resummarize:${id}`,
  });

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
  /**
   * Whether that status is a fact or the placeholder above it.
   *
   * <p>`"CREATED"` is what this reads before the query resolves, which is every
   * first render. It is a real status, so nothing downstream can tell it apart
   * from the server having said so — see where this is used below.
   */
  const statusKnown = Boolean(live?.status ?? meeting.data?.status);
  const ready = status === "READY";
  const failed = status === "FAILED";
  const terminal = isTerminal(status);

  /**
   * The percentage on the card, from the socket and the poll together.
   *
   * <p>Called here rather than beside the card because the card is conditional
   * and this is not: the number has to keep being computed while the meeting
   * runs, or every stage it spent hidden would be forgotten. See lib/progress.
   */
  const percent = useMeetingProgress(id, status, live?.progress ?? statusProgress(status));

  // Read here rather than inside `onReprocess`, which is not a component and
  // so cannot call a hook. Used only to say what a reprocess will cost.
  const allowance = useAllowance();

  const audio = useAudioController();

  React.useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => meeting.refetch(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, id]);

  /**
   * Opening a meeting that is still being made is enough to start following it.
   *
   * <p>Without this the watcher only knew about jobs started in this tab, so a
   * recording made on a phone — or one whose tab was reloaded — showed a
   * progress banner here and nothing anywhere else, and navigating away lost
   * sight of it entirely. Tracking is idempotent and the watcher drops the id
   * itself once the meeting settles, so this is safe to run on every render
   * where the meeting is unfinished.
   *
   * <p><b>Not until the status is actually known.</b> `status` falls back to
   * `CREATED` while the query is in flight, which is not terminal — so opening
   * a meeting that finished last week tracked it for the frame before the
   * server answered, and the watcher then announced "it is ready" about a
   * meeting nobody had been waiting for. The watcher no longer announces a
   * completion it did not see happen either; this is the other half, and it
   * stops the pointless poll as well as the pointless toast.
   */
  React.useEffect(() => {
    if (!statusKnown || terminal) return;
    trackProcessing(id);
  }, [statusKnown, terminal, id]);

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

  /*
   * Asked for while the meeting is still being made, not only once it is READY.
   *
   * These three used to be skipped until `ready`, which is what made the page a
   * progress card with nothing behind it: there was no data because nothing had
   * asked for any. Skipping now means only "this meeting failed, there will
   * never be anything" -- so whether a transcript exists is a question that gets
   * answered rather than assumed, and the stage strip below is reading a fact.
   *
   * On today's backend `CallbackService.applyResult` writes the transcript, the
   * summary, the action items and the READY status in one transaction, so in
   * practice all three arrive together. That is deliberately not baked in here:
   * the UI reveals whatever exists whenever it exists, so a backend that starts
   * persisting the transcript earlier needs no change on this page.
   */
  const summary = useGetSummaryQuery(id, { skip: failed });
  const transcript = useGetTranscriptQuery(id, { skip: failed });
  const actions = useGetMeetingActionItemsQuery(id, { skip: failed });
  /*
   * What actually exists -- as three states, not two.
   *
   * `hasSummary = Boolean(summary.data)` was the bug behind two of the
   * screenshots. `data` is undefined for four different reasons -- the request
   * failed, it is still in flight, it was never asked, or the server really
   * has nothing -- and only the last of them is "this meeting has no summary".
   * Collapsing them to a boolean meant a 500 or a 401 on a *finished* meeting
   * came out the far side as "No summary available.", which is a confident
   * statement about somebody's data made on the strength of a request that
   * never answered. The transcript beside it said "Transcript unavailable." for
   * exactly the same reason.
   *
   * There is deliberately no `??` and no `Boolean()` on these three anywhere in
   * this file. Both are how the distinction gets lost, and both are easy to
   * write back in without noticing; lib/meeting-panels holds the mapping, and
   * its tests hold the argument list.
   */
  const queries = { summary, transcript, actions };
  const { hasTranscript, hasSummary } = meetingHas(queries);
  /** Still being made. Distinct from `failed`, which has its own screen. */
  const processing = !terminal;
  /*
   * What each area shows, decided in one place from what actually exists.
   *
   * Pure and tested on its own (lib/processing-stages), because it is the part
   * that regresses quietly: one `&&` in the wrong place turns "generating your
   * summary" back into "No summary available", which is the message this whole
   * change exists to stop showing over a summary that is being written.
   */
  const view = revealPlan({
    status,
    reported: live?.progress,
    hasTranscript,
    hasSummary,
  });
  /*
   * The two questions, composed -- see lib/meeting-panels.
   *
   * `view` answers "is the meeting finished"; these answer "and did the request
   * succeed", which the page never used to ask. Both are needed: a summary that
   * has not been written yet is not a summary that failed to load, and a
   * summary that failed to load is not a summary that does not exist.
   */
  const {
    summary: summaryState,
    transcript: transcriptState,
    actionItems: actionsState,
  } = meetingPanels(queries, view);
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
   * "Present:" is the line every set of minutes opens with, and Reverie knows
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
   * Run the whole pipeline again over the same audio.
   *
   * <b>Destructive, and the confirm says exactly how.</b> Reprocessing rebuilds
   * the transcript from the recording, so every line anybody corrected by hand
   * and every speaker they named goes back to what the transcriber produces.
   * Nothing merges the old work into the new text — the segments are replaced
   * wholesale, and there is no version of "keep my edits" that would not mean
   * pasting corrections onto lines that may no longer exist.
   *
   * Not awaited to completion: the server answers 202 with a queued job, and
   * the page follows the meeting's status from there like any other processing
   * meeting.
   */
  async function onReprocess() {
    // What it costs, first.
    //
    // This dialog warned about the hand corrections and the speaker names,
    // and said nothing at all about the minutes, which are not replaceable.
    // Reprocessing sends the audio back to the provider and is charged again
    // in full, so a thirty-minute meeting reprocessed three times has spent
    // ninety of the hundred an account ever gets. Until now the button that
    // did that looked free. See reprocessCost.
    const cost = reprocessCost(allowance, m?.durationSeconds);
    const warning = m?.status === "FAILED"
      ? "Try processing this meeting again?\n\n" + cost
      : "Reprocess this meeting?\n\n" + cost
        + "\n\nThe transcript and summary will be rebuilt from the recording. "
        + "Any corrections you typed, and any speakers you named, will be replaced.";
    if (!window.confirm(warning)) return;
    try {
      await reprocessMeeting(id).unwrap();
      // The last event this page heard said READY, and `status` prefers the
      // socket over the refetched meeting — so leaving it there would keep the
      // whole page in its finished state, showing the summary about to be
      // replaced, until the worker's first event arrived minutes later. The
      // meeting is QUEUED as of this line; forget what it used to be.
      setLive(null);
      toast.success("Reprocessing started.", {
        description: "The transcript and summary are being rebuilt.",
      });
    } catch {
      toast.error("Could not start reprocessing.");
    }
  }

  async function onDelete() {
    if (!window.confirm("Delete this meeting and all its data?")) return;
    try {
      await remove(id).unwrap();
      toast.success("Meeting deleted.");
      router.push(HOME);
    } catch {
      toast.error("Could not delete.");
    }
  }

  /*
   * Four outcomes, decided in one place -- see `meetingState` in
   * lib/meeting-panels, where the matrix is asserted.
   *
   * This was `isLoading` -> skeleton, `isError` -> error screen, and the second
   * half is what made an open meeting vanish. RTK Query sets `isError` on a
   * *refetch* that fails while keeping the last good `data`, and this page
   * refetches constantly -- an invalidation after a rename, a socket event, a
   * tab regaining focus. So a blip during any of those replaced a meeting
   * somebody was reading with an error card about it, when the meeting was
   * still right there in the cache.
   *
   * Before that it was `isError || !data`, which said "Meeting not found" for
   * every failure -- the most alarming false thing this page could say.
   */
  const loadState = meetingState(
    {
      isUninitialized: meeting.isUninitialized,
      isLoading: meeting.isLoading,
      isFetching: meeting.isFetching,
      isError: meeting.isError,
      isSuccess: meeting.isSuccess,
      hasData: meeting.data !== undefined,
      error: meeting.error,
    },
    isNotFoundError,
  );
  if (loadState === "loading") return <Skeleton className="h-64 w-full" />;
  if (loadState !== "ready") {
    // "Meeting not found" only for a real 404; everything else gets the retry
    // screen. MeetingLoadError makes that split from the error itself.
    return <MeetingLoadError error={meeting.error} onRetry={() => void meeting.refetch()} />;
  }
  // `ready` means there is a body. Narrowed for TypeScript, which cannot see
  // that through the function above.
  if (!meeting.data) return <Skeleton className="h-64 w-full" />;

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
      // The only source of a duration for anything recorded in the browser:
      // WebM out of a MediaRecorder carries none, so the element reports
      // Infinity and the scrubber has nothing to divide by. See
      // `playbackDuration` in lib/playback.ts.
      durationSeconds={m.durationSeconds}
      // Skip-silence, the speaker jumps and the coloured timeline are all read
      // out of the transcript rather than the audio signal — see
      // lib/playback.ts. Both queries are already in flight for the tabs below,
      // so RTK Query serves these from the same request.
      segments={transcript.data?.segments ?? []}
      moments={moments.data ?? []}
      // `audioUrl` is presigned and lasts fifteen minutes. This page is often
      // open for longer — reading the transcript is the point — and nothing
      // refreshes it, so the link the player is holding eventually stops
      // working. Refetching the meeting mints a new one; the player remembers
      // where the listener was and puts them back.
      onSourceExpired={() => void meeting.refetch()}
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
        {/* Nothing cleared past the chat any more: it is a pane of the shell
            and the header ends where it begins. What did move out of this row
            is Import and Record — they made a *different* meeting, at the same
            end of the same bar as the buttons that act on this one. See
            lib/chrome.ts. */}
        <div className="flex items-center gap-2 no-print">
          {ready && (
            <>
              {/* A button, not a menu. Everything that used to hang off it —
                  copying, erasing — moved onto the one menu that holds every
                  other operation, so a control named Export now does exactly
                  what it says. */}
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setExporting(true)}>
                {/* Up: out of Reverie. See the Import button in
                    components/app-shell.tsx for the pairing. */}
                <Upload className="h-4 w-4" /> Export
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
              visible "No folder" — a label reading as a problem to fix on the
              overwhelming majority of meetings, in the one place somebody came
              to read rather than to tidy. Which folder a meeting is in is a
              thing you go and change, not a fact about the meeting worth
              stating beside its date. */}
          {/* Hidden while processing. Everything in it that needs a
              transcript is already gated off at that point, so what is left is
              Move, Copy link and Delete — three actions nobody wants mid-wait,
              drawn as a menu button in the corner of a page with one card on
              it. It returns the moment the meeting is READY or FAILED, which
              is when the rest of it starts to matter. */}
          {terminal && <MeetingMenu
            meetingId={id}
            projectId={m.projectId}
            hasTranscript={(transcript.data?.segments?.length ?? 0) > 0}
            hasSummary={ready && Boolean(summary.data)}
            canTranslate={ready}
            // Change language and Regenerate grey while either is running.
            // Both end in the summary being rewritten, and starting a second
            // one on top of the first is the race this closes.
            working={regenerating || translating}
            busy={removeState.isLoading}
            onCopySummary={() => void onCopySummary()}
            onCopyTranscript={() => void onCopyTranscript()}
            onRegenerateSummary={() => void onRegenerateSummary()}
            onTranslate={() => setPickingLanguage(true)}
            onReprocess={() => void onReprocess()}
            reprocessing={reprocessing}
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
          <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-20 p-3 sm:p-4 lg:left-[var(--rail-w,16rem)] lg:right-[var(--side-pane-w,0px)]">
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
          progress={percent}
          // The *reported* progress, not the eased bar: the stage strip must
          // never tick a stage because a timer moved. See lib/processing-stages.
          reported={live?.progress}
          hasTranscript={hasTranscript}
          hasSummary={hasSummary}
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
              <p className="text-sm text-muted-foreground">{m.errorMessage || "Something went wrong while processing this recording."}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        * Rendered while processing too, where this used to be `ready &&`.
        *
        * The layout, the tabs and the chat rail are the same components in the
        * same places; only what each *shows* differs while its data is missing.
        * A failed meeting still gets nothing -- it has its own card above, and
        * skeletons over a failure are the "spinning for ever" case.
        */}
      {view.content && (
        /*
         * Two columns and two tabs, where there were four tabs and one column.
         *
         * Ask and Action items are not places, and making them tabs meant the
         * two things you do *while* reading — question it, and see what you
         * agreed to — were both somewhere the reading was not. The chat is now
         * a rail that stays put, and the action items sit under the summary
         * they were extracted from.
         */
        <>
        <Tabs value={tab} onValueChange={changeTab} className="min-w-0">
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
            {/* Only once there is a summary to rewrite. Offering a template
                picker over a brief that does not exist yet is a control that
                cannot do anything. */}
            {tab === "summary" && hasSummary && (
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
              // One value rather than `loading` + `pending`, because the two of
              // them together could not express "the request failed" -- so it
              // came out as the empty state, which is the screenshot.
              state={summaryState}
              onRetry={() => void summary.refetch()}
              retrying={summary.isFetching}
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
                  {/* Only over a list that actually arrived. "Everything here is
                      done." is a claim about what the meeting asked of you, and
                      deriving it from `(actions.data ?? []).filter(...)` meant a
                      failed request congratulated the reader on finishing work
                      it had never seen. */}
                  {actionsState === "ready" ? (
                    <p className="text-sm text-muted-foreground">
                      {openActions === 0
                        ? "Everything here is done."
                        : `${openActions} of ${actions.data?.length ?? 0} still open.`}
                    </p>
                  ) : (
                    <span />
                  )}
                  {/* Nothing here needs a transcript selection: a commitment made
                      in the room and never said aloud is exactly the one the
                      extractor cannot find. */}
                  <NewActionItemDialog meetingId={id} />
                </div>

                {actionsState === "ready" ? (
                  <ul className="divide-y divide-border">
                    {(actions.data ?? []).map((a) => (
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
                ) : actionsState === "extracting" || actionsState === "waiting" ? (
                  <ProcessingActionItems ready={actionsState === "extracting"} />
                ) : actionsState === "loading" ? (
                  <div className="space-y-2 py-2" aria-busy>
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-11/12" />
                  </div>
                ) : actionsState === "error" ? (
                  <ResourceLoadError
                    title="Couldn't load the action items"
                    detail="They are still on this meeting. Something went wrong loading them."
                    onRetry={() => void actions.refetch()}
                    retrying={actions.isFetching}
                  />
                ) : (
                  /* Reached only from a settled, successful, genuinely empty
                     list -- see lib/resource-state. */
                  <EmptyText>No action items were extracted.</EmptyText>
                )}
                {/* No "manage all" link any more, and no page behind it. This
                    card is where a commitment out of this call is read and
                    ticked off; a second list of the same rows somewhere else
                    was three places to do one thing. */}
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
            ) : transcriptState === "preparing" ? (
              /* Not an empty TranscriptPanel. An empty transcript looks like a
                 recording that captured nothing, which is the one conclusion
                 that must not be drawn from a meeting still being transcribed. */
              <ProcessingTranscript />
            ) : transcriptState === "error" ? (
              /* The other conclusion that must not be drawn from a request that
                 failed. This is the screenshot: "Transcript unavailable." over a
                 transcript that was in the database the whole time. */
              <Card>
                <CardContent className="pt-6">
                  <ResourceLoadError
                    title="Couldn't load the transcript"
                    detail="Your transcript is still here. Something went wrong loading it."
                    onRetry={() => void transcript.refetch()}
                    retrying={transcript.isFetching}
                  />
                </CardContent>
              </Card>
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
              loading={transcriptState === "loading"}
              // Whether "Transcript unavailable." is a true sentence, decided
              // above rather than from `fallbackText` being falsy -- which is
              // what it used to be, and which is any of four different things.
              empty={transcriptState === "empty"}
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
            />
            )}
          </TabsContent>
        </Tabs>

        {/* The rail, in the shell's pane rather than in this page's layout.
            Its whole purpose is to stay beside the thing being read — a chat
            that scrolls away with the transcript is the tab it replaced, and
            one that ends halfway down the page puts its composer wherever the
            summary happened to stop. As a column of the shell it runs the full
            height of the window and is dragged to whatever width the reader
            wants, instead of approximating both with a sticky offset and a
            clamp this page had to keep in step with the header's. */}
        <SidePane>
          {/* The chat answers questions *about this transcript*, and on today's
              backend the transcript does not exist until the meeting is READY --
              `applyResult` writes it with the summary and the status in one
              transaction. So there is nothing for it to ground an answer in
              before then, and offering a composer would invite a question it
              could only answer wrongly or not at all.

              Keyed off the transcript rather than off the status, so this
              unlocks the moment a transcript exists rather than the moment some
              enum says READY. If the backend starts persisting it earlier, the
              chat opens earlier with no change here. */}
          {view.chat === "locked" ? (
            <ProcessingChatRail />
          ) : (
          <MeetingRail
            meetingId={id}
            title={m.title}
            showOutline={tab === "transcript"}
            sections={showing?.sections ?? summary.data?.sections ?? []}
            suggestions={summary.data?.suggestions}
            composed={composed}
            // Through the switch, not straight to the player: this rail is
            // beside both tabs, so a chat citation can be clicked while the
            // brief is on screen and the player does not exist yet.
            onSeek={playFrom}
          />
          )}
        </SidePane>
        </>
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
  title,
  showOutline,
  sections,
  suggestions,
  composed,
  onSeek,
}: {
  meetingId: string;
  /** What the chat is reading, by name. See `scope` in ChatPanel. */
  title: string;
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
    <Tabs
      value={pane}
      onValueChange={setPane}
      className="flex h-full min-h-0 flex-col"
    >
      <TabsList variant="underline" className="flex shrink-0 gap-x-6 px-4">
        <TabsTrigger value="chat">
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> AI Chat
        </TabsTrigger>
        {showOutline && <TabsTrigger value="outline">Outline</TabsTrigger>}
      </TabsList>

      {/* mt-0 overrides the tab content's default gap: the chat's own header
          supplies the spacing, and doubling it pushes the composer down. */}
      <TabsContent value="chat" className="mt-0 min-h-0 flex-1">
        <ChatPanel
          meetingId={meetingId}
          title={title}
          onCite={onSeek}
          suggestions={suggestions}
          composed={composed}
        />
      </TabsContent>

      {showOutline && (
        <TabsContent value="outline" className="mt-0 min-h-0 flex-1 overflow-y-auto p-4">
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
  // Shared with the menu and the banner — see the page's own call. A rewrite
  // started anywhere shows as "Rewriting…" here, which is where a reader looks
  // to find out what the brief in front of them is.
  const [resummarize, { isLoading: rewriting }] = useResummarizeMutation({
    fixedCacheKey: `resummarize:${meetingId}`,
  });
  // Changing the template *is* a rewrite — same request the menu item makes —
  // so the same allowance closes it. Without this the one surface that does not
  // look like a button would still spend a model call.
  const refusal = aiRefusal(useAllowance(), "summary");

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
      <Select value={current} onValueChange={onChange} disabled={rewriting || refusal !== null}>
        {/* The spinner sits beside the word, not in a wrapper around it.
            SelectTrigger styles its direct `span` with `line-clamp-1`, which is
            `display: -webkit-box` with a vertical box orientation — and as a
            child selector it outranks a `flex` class on that same span. So a
            span holding an icon and a word laid them out *down* the trigger:
            the spinner above "Rewriting...", both spilling out of a row eight
            units tall. The trigger is already a flex row that centres what it
            is handed, which is all this ever needed. Same shape as the folder
            icon in components/project-picker. */}
        {/* The reason, on the control itself. There is no room beside it on
            the tab row for a sentence, and a picker that simply stops working
            is the worst of the three options. */}
        <SelectTrigger className="h-8 w-[170px] gap-2" title={refusal ?? undefined}>
          {rewriting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              {/* mr-auto because the trigger is justify-between: without it the
                  three children — spinner, word, chevron — would space
                  themselves out evenly across the whole width. */}
              <span className="mr-auto text-muted-foreground">Rewriting...</span>
            </>
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
  state,
  onRetry,
  retrying,
  summary,
  translation,
  onSeek,
}: {
  meetingId: string;
  /**
   * What this panel is allowed to say -- see lib/meeting-panels.
   *
   * <p>One value, replacing a `loading` boolean and a `pending` flavour. The
   * pair of them could express "still loading" and "still being written" but
   * had no way at all to express "the request failed", so a failure fell
   * through to the last branch and said "No summary available." over a summary
   * that existed. That is the screenshot this prop exists for.
   *
   * <p>`"waiting"` is before the transcript exists -- there is nothing to
   * summarise. `"generating"` is after it, while the model is writing.
   * `"empty"` is the only state in which "No summary available" is a true
   * sentence, and it is reached only from a settled successful response or a
   * settled 404 (`getSummary` answers absence with `notFound("Summary not
   * ready")`).
   */
  state: PanelState;
  onRetry: () => void;
  retrying: boolean;
  summary?: SummaryResponse;
  /** The brief in the reading language, when one has been chosen. */
  translation?: MeetingTranslation;
  /** Plays from a quotation's moment. Shared with the transcript and chat. */
  onSeek: (seconds: number) => void;
}) {
  // The picker itself lives on the tab row now (see TemplatePicker). This call
  // stays because the "the transcript changed" banner below rewrites with the
  // template already in use, which is the same request without the choosing.
  // Same fixed key as the other two, so all three know when one is running.
  const [resummarize, { isLoading: rewriting }] = useResummarizeMutation({
    fixedCacheKey: `resummarize:${meetingId}`,
  });
  // The banner below offers a rewrite, which is the same spend as the menu's.
  const refusal = aiRefusal(useAllowance(), "summary");
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
        {/* What we have beats any news about the request that fetched it: a
            refetch that fails must not blank a summary somebody is reading. */}
        {view ? (
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
                {/* On a spent account the offer is withdrawn rather than
                    greyed. This banner exists to ask for a decision, and a
                    disabled button leaves it asking for one that cannot be
                    made — the warning is still worth showing, since it is why
                    the summary and the transcript below it disagree, but the
                    reader needs the reason instead of the button. */}
                {refusal ? (
                  <span className="text-xs text-muted-foreground">{refusal}</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onTemplateChange(current)}
                    disabled={rewriting}
                  >
                    {rewriting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Rewrite it
                  </Button>
                )}
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
        ) : state === "waiting" || state === "generating" ? (
          <ProcessingSummary stage={state} />
        ) : state === "loading" ? (
          <Skeleton className="h-24 w-full" />
        ) : state === "error" ? (
          <ResourceLoadError
            title="Couldn't load the summary"
            detail="Your summary is still here. Something went wrong loading it."
            onRetry={onRetry}
            retrying={retrying}
          />
        ) : (
          /* Reached only from a settled response that proved there is none.
             See lib/resource-state -- this branch used to be reached by
             `!summary.data`, which is also what a 500 looks like. */
          <EmptyText>No summary available.</EmptyText>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------- Chat panel ------------------------------ */
function ChatPanel({
  meetingId,
  title,
  onCite,
  suggestions,
  composed,
}: {
  meetingId: string;
  /**
   * The meeting this chat reads, by name.
   *
   * The chip used to say "This meeting", which was true and became unhelpful
   * the moment the panel could be maximised over the page: with the document
   * covered, "this" names nothing the reader can see. The title is on screen
   * either way now, and it is also what makes the scope obviously *narrow* —
   * somebody who has just come from the workspace chat needs to know this one
   * answers from one transcript.
   */
  title: string;
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
  // Only for the maximise control's own state. The pane itself is the shell's.
  const pane = useSidePane();
  /*
   * How hard to look, the same two settings the workspace chat offers.
   *
   * Not here originally, on the recorded ground that one meeting was retrieved
   * in full either way and a picker would be a control that did nothing. That
   * was wrong: retrieval takes the nearest eight passages, and a
   * fifteen-minute recording already chunks to more than eight, so a long
   * meeting was being answered from a sample of itself. Thorough widens that
   * and asks for an enumerated answer. See rag.answer in the ai-service.
   *
   * The wording comes from the server so it cannot drift from what the two
   * settings actually do.
   */
  const { data: modes } = useGetChatModesQuery();
  const [mode, setMode] = React.useState<ChatMode>("express");

  const {
    currentData: messages,
    isFetching,
    isError: chatError,
    // Skipped until a thread is named: history without one returns the most
    // recent conversation, which is what used to resume an old chat on open.
    //
    // `currentData` rather than `data`, for the reason spelled out in
    // lib/use-workspace-chat: a skipped query keeps its last result in `data`,
    // so deleting the open thread left its messages on screen.
  } = useGetChatQuery(
    { id: meetingId, conversationId: conversationId ?? undefined },
    { skip: !conversationId },
  );

  // Nothing to show and something coming — not merely "a request is in
  // flight", which is also true of the refetch after every answer.
  const isLoading = isFetching && !messages;
  const { data: conversations } = useGetMeetingConversationsQuery(meetingId);
  const [ask, { isLoading: asking }] = useAskChatMutation();
  // The question, on screen from the click rather than from the refetch that
  // follows the answer. See lib/pending-turn.
  // Scoped to this meeting, so a question still being answered survives going
  // to look at another meeting and coming back. Not shared with the workspace
  // chat: coming back to a meeting is coming back to one document, and what you
  // were asking about it is part of reading it.
  const pending = usePendingTurn(messages, `meeting:${meetingId}`);
  const [newConversation, { isLoading: starting }] = useCreateMeetingConversationMutation();
  const [rename] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();
  // The composer owns what is typed. What stays here is the prefill: the
  // transcript can send a passage over as "ask about this", and only the page
  // knows when that happened.
  const [composeText, setComposeText] =
    React.useState<{ text: string; nonce: number } | null>(null);
  // Follows the newest turn, inside the thread and nowhere else, and stops
  // following the moment the reader scrolls up. See lib/use-thread-scroll.
  const threadRef = useThreadScroll([messages, pending.turn]);
  // Keyed by meeting: two meetings open in two tabs each get their own row,
  // and coming back to one carries on through its pool rather than restarting.
  const prompts = useRotatingPrompts(
    meetingId,
    toPrompts(suggestions, MEETING_PROMPTS),
    conversationId,
  );

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
    // Handed to the composer, which owns the box and does the focusing.
    setComposeText({ text: composed.text, nonce: composed.nonce });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed?.nonce]);

  async function submit(text: string) {
    const question = text.trim();
    if (!question) return;
    // Before the first await, so the question appears in the same commit that
    // clears the composer rather than a round trip later.
    pending.begin(question);
    try {
      // Its own thread when none is named, rather than being appended to the
      // last one. The server's rule for an unnamed ask is "continue the most
      // recent, or start one", so a clean sheet on screen would otherwise file
      // the question into a conversation it is not showing.
      const target = conversationId ?? (await newConversation(meetingId).unwrap()).id;
      // Adopted before the answer is waited for. Setting it from the response
      // meant a first question on a new thread belonged nowhere until the answer
      // landed, so leaving during that window came back to a clean sheet with
      // the answer only findable through the history picker.
      setConversationId(target);
      // Where it was asked from, so an answer that lands while the user is on
      // another page can offer the way back.
      const askedOn = typeof window === "undefined" ? "" : window.location.pathname;
      const answer = await ask({
        id: meetingId,
        question,
        conversationId: target,
        mode,
      }).unwrap();
      setConversationId(answer.conversationId);
      announceAnswer(askedOn);
    } catch {
      // Kept on screen with the failure under it and a Retry beside it. A toast
      // and an empty rail means retyping the question, which the composer has
      // already cleared.
      pending.fail();
    }
  }
  submitRef.current = submit;

  async function onNew() {
    try {
      const created = await newConversation(meetingId).unwrap();
      setConversationId(created.id);
      pending.clear();
      // Clears the box: a half-typed question belongs to the thread it was
      // being asked in.
      setComposeText({ text: "", nonce: Date.now() });
    } catch {
      toast.error("Couldn't start a new chat.");
    }
  }

  return (
    <ChatRail
      scrollRef={threadRef}
      header={
        <ChatHistory
          conversations={conversations ?? []}
          activeId={conversationId}
          // Same rule as the workspace chat: an empty thread has nothing to
          // start. See `isNew` in lib/use-workspace-chat.
          atNewChat={!isLoading && (messages?.length ?? 0) === 0}
          onSelect={setConversationId}
          onNew={onNew}
          busy={starting}
          // In place rather than by navigating. There is no full page for one
          // meeting's chat, and adding a route to hold a second copy of this
          // conversation would be a URL nobody could get back from with the
          // transcript still on screen. See components/side-pane.tsx.
          onExpand={toggleSidePaneExpanded}
          expanded={pane.expanded}
          onRename={async (id, title) => {
            await rename({ conversationId: id, title, scope: meetingId }).unwrap();
          }}
          onDelete={async (id) => {
            await removeConversation({ conversationId: id, scope: meetingId }).unwrap();
            // The open thread just went, so this chat has none: a clean sheet
            // with the starter prompts, not the messages of a conversation
            // that no longer exists.
            if (id === conversationId) {
              setConversationId(null);
              pending.clear();
              setComposeText({ text: "", nonce: Date.now() });
            }
          }}
        />
      }
      dock={
        <ChatDock
          prompts={prompts}
          // An empty thread only. A thread with a question in flight is not
          // one, and three disabled pills across the rail put chrome where the
          // answer is about to be.
          showPrompts={!isLoading && (messages?.length ?? 0) === 0 && !pending.turn}
          busy={asking}
          onSend={(prompt) => void submit(prompt)}
          onCompose={(prefix) => setComposeText({ text: prefix, nonce: Date.now() })}
        >
          <ChatComposer
            busy={asking}
            modes={modes}
            mode={mode}
            onModeChange={setMode}
            // Still no context picker. That one would be a control that does
            // nothing: meeting chat reads one meeting through one endpoint and
            // has no way to widen the scope.
            scope={title || "This meeting"}
            placeholder="Ask about this meeting"
            compose={composeText}
            onSend={submit}
          />
        </ChatDock>
      }
    >
      <>
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
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-muted"
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
          {pending.turn && (
            <PendingTurn
              turn={pending.turn}
              onRetry={() => void submit(pending.turn!.question)}
            />
          )}
      </>
    </ChatRail>
  );
}

/* ---------------------------- Transcript panel --------------------------- */
function TranscriptPanel({
  meetingId,
  loading,
  empty,
  segments,
  speakerStats,
  fallbackText,
  currentTime,
  onSeek,
  onAskAbout,
}: {
  meetingId: string;
  loading: boolean;
  /**
   * Whether the request settled and proved this meeting has no transcript.
   *
   * <p>Decided by the page from the query's state, not from `fallbackText`
   * being falsy -- which is what the old code did, and which is equally true of
   * a 500, a 401 during the token race, and a refetch still in flight. That is
   * how "Transcript unavailable." came to be printed over a transcript.
   */
  empty: boolean;
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
}) {
  const [renameSpeakers, { isLoading: renaming }] = useRenameSpeakersMutation();
  const [mergeSpeakers, { isLoading: merging }] = useMergeSpeakersMutation();
  const [editing, setEditing] = React.useState(false);

  // Names this user has used before. Offered as autocomplete rather than a
  // forced choice: a new person in the meeting must not be harder to name than
  // a familiar one.

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
  const [reassignFor, setReassignFor] = React.useState<ReassignTarget | null>(null);
  /** Why the last correction failed, shown in the dialog rather than only as a toast. */
  const [reassignError, setReassignError] = React.useState<string | null>(null);
  const [setSegmentSpeaker, { isLoading: reassigning }] = useSetSegmentSpeakerMutation();
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

  async function confirmReassign(speakerKey: string) {
    await applyReassign({ speakerKey }, "Speaker corrected for that line.");
  }

  /**
   * The words belong to somebody this meeting does not have yet.
   *
   * <p>The server allocates the identity, so the name is not known until it
   * answers — which is why the toast reads it back off the response rather than
   * guessing "Speaker 5" from what the client can see.
   */
  async function confirmReassignToNew() {
    const speaker = await applyReassign({ newSpeaker: true }, null);
    if (speaker) toast.success(`Assigned to ${speaker}.`);
  }

  async function applyReassign(
    target: { speakerKey?: string; newSpeaker?: boolean },
    message: string | null,
  ): Promise<string | null> {
    if (!reassignFor) return null;
    setReassignError(null);
    try {
      const updated = await setSegmentSpeaker({
        id: meetingId,
        segmentId: reassignFor.segmentId,
        ...target,
        fromWord: reassignFor.fromWord,
        toWord: reassignFor.toWord,
      }).unwrap();
      setReassignFor(null);
      clearSelection();
      if (message) toast.success(message);
      // Whoever holds the corrected line now. A split makes new rows, so this
      // is read back rather than remembered.
      const moved = updated.segments?.find((s) => s.id === reassignFor.segmentId);
      return moved?.speaker ?? updated.speakers?.at(-1)?.speaker ?? null;
    } catch (err) {
      // The server can still refuse a correction, and its sentence is worth
      // showing: "try again in a moment" is different advice from "that did
      // not save", and only the server knows which one applies.
      const detail = (err as { data?: { message?: string } })?.data?.message;
      // Shown in the dialog as well as a toast, and the dialog stays open: the
      // selection is still there and the next attempt should not need making it
      // again.
      setReassignError(detail || "Could not change the speaker on that line.");
      toast.error(detail || "Could not change the speaker on that line.");
      return null;
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
      case "reassign": {
        // One segment at a time. A selection spanning two turns is ambiguous
        // about what is being corrected -- the words, or the boundary between
        // them -- and guessing would move text the user never pointed at.
        if (p.ranges.length !== 1) {
          toast.error("Select words inside a single turn to change its speaker.");
          break;
        }
        const range = p.ranges[0];
        const seg = segments.find((x) => x.id === range.segmentId);
        // `id` is optional on the wire: transcripts recorded before segments
        // were addressable have none, and those cannot be corrected line by
        // line. Refusing beats sending `undefined` as a path segment.
        if (!seg?.id) {
          toast.error("This transcript is too old to correct line by line.");
          break;
        }
        const span = wordRangeFor(seg, range.startOffset, range.endOffset);
        const whole =
          span === null ||
          (span.fromWord === 0 && span.toWord === (seg.words?.length ?? 0) - 1);
        setReassignFor({
          segmentId: seg.id,
          // Omitted for a whole turn so the server moves the row rather than
          // splitting it into one piece.
          fromWord: whole ? undefined : span?.fromWord,
          toWord: whole ? undefined : span?.toWord,
          quote: whole ? seg.text : p.quote,
          currentKey: seg.speakerKey ?? null,
        });
        break;
      }
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

  async function saveNames(mapping: Record<string, string>) {
    if (Object.keys(mapping).length === 0) {
      setEditing(false);
      return;
    }
    try {
      await renameSpeakers({ id: meetingId, mapping }).unwrap();
      toast.success("Speakers renamed.");
      setEditing(false);
    } catch {
      toast.error("Rename failed.");
    }
  }

  /**
   * Fold one speaker into another.
   *
   * <p>The server's message is shown rather than a generic failure: the two
   * refusals a user can actually hit — a speaker that is no longer in this
   * meeting, and a transcript that has moved on since the panel was opened —
   * both mean "reload", and "Merge failed" would not say so.
   */
  async function mergeTwoSpeakers(fromSpeakerKey: string, intoSpeakerKey: string) {
    try {
      await mergeSpeakers({ id: meetingId, fromSpeakerKey, intoSpeakerKey }).unwrap();
      toast.success("Speakers merged.");
      setEditing(false);
    } catch (err) {
      const message = (err as { data?: { message?: string } })?.data?.message;
      toast.error(message || "Could not merge those speakers.");
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <Users className="h-4 w-4" /> Talk time
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Edit speakers"}
              </Button>
            </div>
            {editing ? (
              <SpeakerEditor
                // Server stats where they exist, because only those carry the
                // canonical key a merge needs. The local fallback below is for
                // a transcript cached before the server sent them, and it can
                // still be renamed.
                speakers={
                  speakerStats.length > 0
                    ? speakerStats
                    : speakers.map((sp) => ({
                        speaker: sp,
                        speakerKey: null,
                        speakingSeconds: talk.map.get(sp) ?? 0,
                        percentage: 0,
                        segmentCount: 0,
                        wordCount: 0,
                      }))
                }
                renaming={renaming}
                merging={merging}
                onRename={saveNames}
                onMerge={mergeTwoSpeakers}
              />
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
        ) : empty ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Transcript unavailable.
          </p>
        ) : (
          /* No segments, but text -- a document import, or a transcript from
             before segments existed. Both are real transcripts. */
          <p className="whitespace-pre-wrap text-sm">{fallbackText}</p>
        )}
      </CardContent>

      <SelectionMenu anchor={picked?.anchor ?? null} onAction={onSelectionAction} busy={marking} />
      <ReassignSpeakerDialog
        target={reassignFor}
        speakers={speakerStats ?? []}
        busy={reassigning}
        error={reassignError}
        onClose={() => {
          setReassignFor(null);
          setReassignError(null);
        }}
        onConfirm={confirmReassign}
        onConfirmNew={() => void confirmReassignToNew()}
      />
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
