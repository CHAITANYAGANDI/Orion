"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
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
  useTranslateSummaryMutation,
  useRenameSpeakersMutation,
  useRematchSpeakerMutation,
  useGetKnownSpeakersQuery,
  useEditSegmentsMutation,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
} from "@/lib/api";
import type {
  SpeakerStats,
  SpokenWord,
  SummaryResponse,
  SummarySection,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { StatusBadge, PriorityBadge } from "@/components/status-badge";
import { AudioPlayer, useAudioController } from "@/components/audio-player";
import { ShareDialog } from "@/components/share-dialog";
import { FollowUpEmail } from "@/components/follow-up-email";
import { downloadMarkdown } from "@/lib/export-markdown";
import { subscribeMeetingStatus } from "@/lib/ws";
import {
  formatDateTime,
  formatDuration,
  statusLabel,
  statusProgress,
  isTerminal,
  timecode,
} from "@/lib/format";
import { languageName } from "@/lib/language";
import { cn } from "@/lib/utils";
import type { MeetingStatus, StatusEvent, TranscriptSegment } from "@/lib/types";

export default function MeetingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [live, setLive] = React.useState<StatusEvent | null>(null);
  const meeting = useGetMeetingQuery(id);

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

  // Deep link from a workspace-chat citation or a semantic search hit:
  // /meetings/{id}?t=132.5 opens the meeting and seeks to that moment.
  // Read from location rather than useSearchParams() so the page stays
  // prerenderable without a Suspense boundary.
  const seekedRef = React.useRef(false);
  React.useEffect(() => {
    if (seekedRef.current || !ready) return;
    const t = Number(new URLSearchParams(window.location.search).get("t"));
    if (!Number.isFinite(t) || t <= 0) return;
    const el = audio.ref.current;
    if (!el) return;
    seekedRef.current = true;
    const seek = () => audio.seekTo(t);
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const summary = useGetSummaryQuery(id, { skip: !ready });
  const transcript = useGetTranscriptQuery(id, { skip: !ready });
  const actions = useGetMeetingActionItemsQuery(id, { skip: !ready });

  const [reprocess, reprocessState] = useReprocessMeetingMutation();
  const [remove, removeState] = useDeleteMeetingMutation();

  function onExportMarkdown(includeTranscript: boolean) {
    if (!meeting.data) return;
    downloadMarkdown({
      meeting: meeting.data,
      summary: summary.data,
      actionItems: actions.data,
      segments: transcript.data?.segments,
      includeTranscript,
    });
  }

  async function onReprocess() {
    try {
      await reprocess(id).unwrap();
      setLive(null);
      toast.success("Reprocessing started.");
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/search" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> All meetings
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{m.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={status} />
            {/* A document has no runtime, so a duration would be meaningless. */}
            {!isDocument && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> {formatDuration(m.durationSeconds)}
              </span>
            )}
            <span>{formatDateTime(m.createdAt)}</span>
            {/* Only worth showing when it isn't the default — an "English"
                badge on every meeting is noise. */}
            {m.language && m.language.slice(0, 2).toLowerCase() !== "en" && (
              <Badge variant="outline">{languageName(m.language)}</Badge>
            )}
            {isDocument && <Badge variant="outline">Document</Badge>}
            {m.sourceType === "YOUTUBE" && m.sourceUrl && (
              <a
                href={m.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              >
                <Youtube className="h-3.5 w-3.5" /> Watch on YouTube
              </a>
            )}
            {m.tags?.map((t) => (
              <Badge key={t} variant="secondary">{t}</Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 no-print">
          {ready && (
            <>
              <ShareDialog meetingId={id} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Download className="h-4 w-4" /> Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onExportMarkdown(false)}>
                    Markdown (.md)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onExportMarkdown(true)}
                    disabled={!transcript.data?.segments?.length}
                  >
                    Markdown with transcript
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => window.print()}>
                    PDF (via print)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <Button variant="outline" size="sm" onClick={onReprocess} disabled={reprocessState.isLoading || !terminal}>
            {reprocessState.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reprocess
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} disabled={removeState.isLoading} aria-label="Delete">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Media player (synced with transcript). A DOCUMENT's presigned URL
          points at the source PDF, not audio, so the player must stay away. */}
      {ready && m.audioUrl && !isDocument && (
        <div className="no-print">
          <AudioPlayer src={m.audioUrl} controller={audio} contentType={m.contentType} />
        </div>
      )}

      {/* Processing / failed */}
      {!terminal && <ProcessingCard status={status} progress={live?.progress ?? statusProgress(status)} message={live?.message} />}
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
        <Tabs defaultValue="summary">
          <TabsList className="flex-wrap">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="ask"><Sparkles className="mr-1 h-3.5 w-3.5" /> Ask</TabsTrigger>
            <TabsTrigger value="actions">Action items {actions.data ? `(${actions.data.length})` : ""}</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>

          {/* Summary + translation */}
          <TabsContent value="summary">
            <SummaryPanel
              meetingId={id}
              loading={summary.isLoading}
              summary={summary.data}
              onSeek={audio.seekTo}
            />
          </TabsContent>

          {/* Ask-the-meeting RAG chat */}
          <TabsContent value="ask">
            <ChatPanel meetingId={id} onCite={(s) => audio.seekTo(s)} />
            <FollowUpEmail meetingId={id} />
          </TabsContent>

          <TabsContent value="actions">
            <Card>
              <CardContent className="pt-6">
                {actions.data && actions.data.length > 0 ? (
                  <ul className="divide-y">
                    {actions.data.map((a) => (
                      <li key={a.id} className="flex items-start justify-between gap-3 py-3">
                        <div>
                          <p className="font-medium">{a.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.ownerName || "Unassigned"}{a.dueDate ? ` · due ${a.dueDate}` : ""}
                          </p>
                          {a.sourceSentence && <p className="mt-1 text-xs italic text-muted-foreground">“{a.sourceSentence}”</p>}
                        </div>
                        <PriorityBadge priority={a.priority} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyText>No action items were extracted.</EmptyText>
                )}
                <Button variant="link" className="mt-2 px-0" asChild>
                  <Link href="/action-items">Manage all action items →</Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="transcript">
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
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/* ----------------------------- Summary panel ----------------------------- */
const LANGUAGES = ["Spanish", "French", "German", "Hindi", "Japanese", "Portuguese", "Arabic"];

/**
 * One section, drawn by its `kind`.
 *
 * The switch is on `kind` rather than on which arrays are non-empty, so an
 * empty section still renders its heading. That is the point: "Budget" with
 * nothing under it tells the reader budget never came up, which is a finding.
 * Inferring the shape from the data would silently hide it.
 */
function SummarySectionView({ section }: { section: SummarySection }) {
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
              <h4 className="mb-1.5 text-sm font-medium">{g.heading}</h4>
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
  onSeek,
}: {
  meetingId: string;
  loading: boolean;
  summary?: SummaryResponse;
  /** Plays from a quotation's moment. Shared with the transcript and chat. */
  onSeek: (seconds: number) => void;
}) {
  const [translate, { data: translated, isLoading: translating, reset }] = useTranslateSummaryMutation();
  const [lang, setLang] = React.useState("Spanish");
  const { data: templates } = useGetSummaryTemplatesQuery();
  const [resummarize, { isLoading: rewriting }] = useResummarizeMutation();

  async function onTranslate() {
    try {
      await translate({ id: meetingId, targetLanguage: lang }).unwrap();
    } catch {
      toast.error("Translation failed.");
    }
  }

  async function onTemplateChange(slug: string) {
    // Drop any translation first: it belongs to the summary being replaced,
    // and leaving it up would show translated text under new headings.
    reset();
    try {
      await resummarize({ id: meetingId, template: slug }).unwrap();
      toast.success("Summary rewritten.");
    } catch {
      toast.error("Could not rewrite the summary.");
    }
  }

  const view = translated ?? summary;
  // Translation returns the flat fields only, so while one is showing we fall
  // back to the classic layout rather than render half-translated sections.
  const sections = translated ? [] : summary?.sections ?? [];
  // Hidden alongside the sections while a translation is showing: a quotation is
  // a claim about the exact words spoken, so displaying it beside translated
  // prose would invite reading it as a translated quote.
  const quotes = translated ? [] : summary?.quotes ?? [];
  const current = summary?.templateSlug ?? "general";

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : view ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {templates && templates.length > 0 && (
                  <Select value={current} onValueChange={onTemplateChange} disabled={rewriting}>
                    <SelectTrigger className="h-8 w-[190px]">
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
                )}
                <Select value={lang} onValueChange={(v) => { setLang(v); reset(); }}>
                  <SelectTrigger className="h-8 w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={onTranslate} disabled={translating}>
                  {translating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
                  Translate
                </Button>
              </div>
              {translated && (
                <Button variant="ghost" size="sm" onClick={() => reset()}>Show original</Button>
              )}
            </div>

            {sections.length > 0 ? (
              <div className="space-y-6">
                {sections.map((s) => (
                  <SummarySectionView key={s.key} section={s} />
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
              /* Summaries written before templates existed, and translations,
                 which only carry the flat fields. */
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
function ChatPanel({ meetingId, onCite }: { meetingId: string; onCite: (s: number) => void }) {
  const { data: messages, isLoading } = useGetChatQuery(meetingId);
  const [ask, { isLoading: asking }] = useAskChatMutation();
  const [q, setQ] = React.useState("");
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const question = q.trim();
    if (!question) return;
    setQ("");
    try {
      await ask({ id: meetingId, question }).unwrap();
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" /> Ask this meeting
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-4 max-h-[420px] space-y-4 overflow-y-auto">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : messages && messages.length > 0 ? (
            messages.map((msg) => (
              <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                    msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                  )}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
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
                </div>
              </div>
            ))
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Ask anything about this meeting — e.g. “What did we decide about storage?” or “What are my tasks?”
            </div>
          )}
          {asking && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="inline h-4 w-4 animate-spin" /> Searching the transcript…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={send} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this meeting…" disabled={asking} />
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
}) {
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

  const turns = React.useMemo(() => {
    if (!needle) return allTurns;
    return allTurns.filter(
      (t) =>
        t.speaker.toLowerCase().includes(needle) ||
        t.segments.some((s) => s.text.toLowerCase().includes(needle)),
    );
  }, [allTurns, needle]);

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
          </div>
        )}

        {/* Talk-time */}
        {speakers.length > 0 && talk.total > 0 && (
          <div className="space-y-2">
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
          <div className="space-y-5">
            {turns.map((turn, i) => (
              <div key={i} className="group flex gap-3">
                <SpeakerAvatar name={turn.speaker} />
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
                    {/* Per-turn reassignment, for the handovers where two people
                        overlap and the whole turn landed on the wrong one. A
                        label-wide rename cannot express this: it would move
                        every other turn with it. Hidden until hover so it does
                        not compete with reading. */}
                    {speakers.length > 1 && turn.segments.some((s) => s.id) && (
                      <select
                        className="ml-auto h-6 rounded border bg-background px-1 text-xs text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
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
                </div>
              </div>
            ))}
            {/* Searched, matched nothing. Without this the panel just empties,
                which reads as a transcript that failed to load. */}
            {needle && turns.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing in this transcript matches “{query.trim()}”.
              </p>
            )}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{fallbackText || "Transcript unavailable."}</p>
        )}
      </CardContent>
    </Card>
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
}) {
  const tokens = React.useMemo(() => {
    if (words && words.length > 0) {
      // A trailing space per word so the line reads normally; the provider
      // strips whitespace from each token.
      return words.map((w) => ({ token: w.text + " ", from: w.start, to: w.end }));
    }

    // Fallback. Each token keeps its trailing whitespace, so joining them
    // reproduces the original text exactly and the weighting counts the gap
    // between words.
    const raw = text.match(/\S+\s*/g) ?? [];
    const chars = raw.reduce((n, t) => n + t.length, 0) || 1;
    const span = Math.max(end - start, 0.001);

    let acc = 0;
    return raw.map((token) => {
      const from = start + (acc / chars) * span;
      acc += token.length;
      return { token, from, to: start + (acc / chars) * span };
    });
  }, [text, start, end, words]);

  return (
    <>
      {tokens.map((w, i) => (
        <span
          key={i}
          role="button"
          tabIndex={0}
          // Stops the enclosing utterance handler from also firing and seeking
          // to the start of the sentence instead of to this word.
          onClick={(e) => {
            e.stopPropagation();
            onSeek(w.from);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onSeek(w.from);
            }
          }}
          className={cn(
            "cursor-pointer rounded transition-colors duration-75 hover:bg-primary/20",
            // Search hits use amber, never the primary tint: the playback
            // highlight already owns that colour, and two meanings sharing one
            // colour would make the moving cursor unreadable while searching.
            match && w.token.toLowerCase().includes(match) &&
              "bg-amber-400/40 text-foreground dark:bg-amber-400/30",
            at >= w.from && at < w.to && "bg-primary/40 text-foreground"
          )}
        >
          {w.token}
        </span>
      ))}
    </>
  );
});

type Turn = { speaker: string; start: number; segments: TranscriptSegment[] };

/** Merge consecutive utterances by the same speaker into one turn. */
function groupIntoTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.segments.push(s);
    } else {
      turns.push({ speaker: s.speaker, start: s.start, segments: [s] });
    }
  }
  return turns;
}

// Fixed palette, picked by a hash of the name rather than by position, so a
// speaker keeps their colour when renamed reorders the list — and so the same
// person looks the same on every visit.
const SPEAKER_COLORS = [
  "bg-blue-500", "bg-amber-500", "bg-emerald-500", "bg-violet-500",
  "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-indigo-500",
];

function speakerColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
}

/** Initial of the speaker's name — "Speaker 3" gives S, "Marcus" gives M. */
function SpeakerAvatar({ name }: { name: string }) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
        speakerColor(name)
      )}
      aria-hidden
    >
      {initial}
    </div>
  );
}

function ProcessingCard({ status, progress, message }: { status: MeetingStatus; progress: number; message?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> {statusLabel(status)}…
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={progress} />
        <p className="text-sm text-muted-foreground">{message || "Working on your meeting brief. This updates live."}</p>
      </CardContent>
    </Card>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
