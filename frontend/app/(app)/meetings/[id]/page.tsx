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
  Bot,
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
} from "lucide-react";
import {
  useGetMeetingQuery,
  useGetSummaryQuery,
  useGetTranscriptQuery,
  useGetMeetingActionItemsQuery,
  useGetDecisionsQuery,
  useGetRisksQuery,
  useReprocessMeetingMutation,
  useDeleteMeetingMutation,
  useGetChatQuery,
  useAskChatMutation,
  useTranslateSummaryMutation,
  useRenameSpeakersMutation,
  useGetSummaryTemplatesQuery,
  useResummarizeMutation,
} from "@/lib/api";
import type { SummaryResponse, SummarySection } from "@/lib/types";
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
  const decisions = useGetDecisionsQuery(id, { skip: !ready });
  const risks = useGetRisksQuery(id, { skip: !ready });

  const [reprocess, reprocessState] = useReprocessMeetingMutation();
  const [remove, removeState] = useDeleteMeetingMutation();

  function onExportMarkdown(includeTranscript: boolean) {
    if (!meeting.data) return;
    downloadMarkdown({
      meeting: meeting.data,
      summary: summary.data,
      decisions: decisions.data,
      actionItems: actions.data,
      risks: risks.data,
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
              <Button variant="outline" size="sm" asChild>
                <Link href="/agent"><Bot className="h-4 w-4" /> Agent</Link>
              </Button>
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

      {/* Audio player (synced with transcript). A DOCUMENT's presigned URL
          points at the source PDF, not audio, so the player must stay away. */}
      {ready && m.audioUrl && !isDocument && (
        <div className="no-print">
          <AudioPlayer src={m.audioUrl} controller={audio} />
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
            <TabsTrigger value="decisions">Decisions {decisions.data ? `(${decisions.data.length})` : ""}</TabsTrigger>
            <TabsTrigger value="risks">Risks {risks.data ? `(${risks.data.length})` : ""}</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>

          {/* Summary + translation */}
          <TabsContent value="summary">
            <SummaryPanel meetingId={id} loading={summary.isLoading} summary={summary.data} />
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

          <TabsContent value="decisions">
            <Card>
              <CardContent className="pt-6">
                {decisions.data && decisions.data.length > 0 ? (
                  <ul className="space-y-3">
                    {decisions.data.map((d, i) => (
                      <li key={d.id ?? i} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">{d.decision}</p>
                          <Badge variant="outline" className="capitalize">{d.confidence}</Badge>
                        </div>
                        {d.sourceSentence && <p className="mt-1 text-xs italic text-muted-foreground">“{d.sourceSentence}”</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyText>No decisions were captured.</EmptyText>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="risks">
            <Card>
              <CardContent className="pt-6">
                {risks.data && risks.data.length > 0 ? (
                  <ul className="space-y-3">
                    {risks.data.map((r, i) => (
                      <li key={r.id ?? i} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">{r.risk}</p>
                          <Badge variant={r.severity === "high" ? "destructive" : "warning"} className="capitalize">{r.severity}</Badge>
                        </div>
                        {r.sourceSentence && <p className="mt-1 text-xs italic text-muted-foreground">“{r.sourceSentence}”</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyText>No risks or blockers were flagged.</EmptyText>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Transcript: synced + speakers + talk-time */}
          <TabsContent value="transcript">
            <TranscriptPanel
              meetingId={id}
              loading={transcript.isLoading}
              segments={transcript.data?.segments ?? []}
              fallbackText={transcript.data?.transcript}
              currentTime={audio.currentTime}
              onSeek={(s) => audio.seekTo(s)}
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
}: {
  meetingId: string;
  loading: boolean;
  summary?: SummaryResponse;
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
  fallbackText,
  currentTime,
  onSeek,
}: {
  meetingId: string;
  loading: boolean;
  segments: TranscriptSegment[];
  fallbackText?: string;
  currentTime: number;
  onSeek: (s: number) => void;
}) {
  const [renameSpeakers, { isLoading: renaming }] = useRenameSpeakersMutation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  const speakers = React.useMemo(() => {
    const set = new Set<string>();
    segments.forEach((s) => s.speaker && set.add(s.speaker));
    return Array.from(set);
  }, [segments]);

  const talk = React.useMemo(() => {
    const map = new Map<string, number>();
    let total = 0;
    for (const s of segments) {
      const d = Math.max(0, (s.end || 0) - (s.start || 0));
      map.set(s.speaker, (map.get(s.speaker) || 0) + d);
      total += d;
    }
    return { map, total };
  }, [segments]);

  const turns = React.useMemo(() => groupIntoTurns(segments), [segments]);

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

  if (loading) return <Card><CardContent className="pt-6"><Skeleton className="h-40 w-full" /></CardContent></Card>;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
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
              <div className="space-y-2">
                {speakers.map((sp) => (
                  <div key={sp} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-sm text-muted-foreground">{sp}</span>
                    <Input
                      className="h-8"
                      placeholder="New name"
                      value={draft[sp] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [sp]: e.target.value }))}
                    />
                  </div>
                ))}
                <Button size="sm" onClick={saveNames} disabled={renaming}>
                  {renaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
                </Button>
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
              <div key={i} className="flex gap-3">
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
                  </div>
                  <p className="text-sm leading-relaxed">
                    {turn.segments.map((s, j) => {
                      const active = currentTime >= s.start && currentTime < s.end;
                      return (
                        <span
                          key={j}
                          role="button"
                          tabIndex={0}
                          onClick={() => onSeek(s.start)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSeek(s.start);
                            }
                          }}
                          className={cn(
                            "cursor-pointer rounded px-0.5 transition-colors hover:bg-accent/60",
                            active && "bg-primary/10"
                          )}
                        >
                          {active ? (
                            <SpokenWords text={s.text} start={s.start} end={s.end} at={currentTime} />
                          ) : (
                            s.text
                          )}{" "}
                        </span>
                      );
                    })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{fallbackText || "Transcript unavailable."}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The utterance currently being spoken, with the word at `at` highlighted.
 *
 * Word times are estimated by spreading the utterance's span across its words
 * in proportion to their length, longer words taking proportionally longer to
 * say. It is an approximation — a pause mid-sentence pushes the highlight
 * ahead of the voice — but the error cannot accumulate, because every
 * utterance boundary resnaps it to a real timestamp, and diarization breaks
 * utterances on exactly those pauses. Exact timing would mean persisting
 * Deepgram's per-word offsets, which are currently discarded.
 *
 * Only rendered for the active utterance, so this splits one short string per
 * frame rather than the whole transcript.
 */
function SpokenWords({
  text,
  start,
  end,
  at,
}: {
  text: string;
  start: number;
  end: number;
  at: number;
}) {
  const words = React.useMemo(() => {
    // Each token keeps its trailing whitespace, so joining them reproduces the
    // original text exactly and the weighting counts the gap between words.
    const tokens = text.match(/\S+\s*/g) ?? [];
    const chars = tokens.reduce((n, t) => n + t.length, 0) || 1;
    const span = Math.max(end - start, 0.001);

    let acc = 0;
    return tokens.map((token) => {
      const from = start + (acc / chars) * span;
      acc += token.length;
      return { token, from, to: start + (acc / chars) * span };
    });
  }, [text, start, end]);

  return (
    <>
      {words.map((w, i) => (
        <span
          key={i}
          className={cn(
            "rounded transition-colors duration-75",
            at >= w.from && at < w.to && "bg-primary/40 text-foreground"
          )}
        >
          {w.token}
        </span>
      ))}
    </>
  );
}

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
