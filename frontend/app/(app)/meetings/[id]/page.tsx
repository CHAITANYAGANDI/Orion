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
} from "@/lib/api";
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
import { StatusBadge, PriorityBadge } from "@/components/status-badge";
import { AudioPlayer, useAudioController } from "@/components/audio-player";
import { subscribeMeetingStatus } from "@/lib/ws";
import {
  formatDateTime,
  formatDuration,
  statusLabel,
  statusProgress,
  isTerminal,
  timecode,
} from "@/lib/format";
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

  const summary = useGetSummaryQuery(id, { skip: !ready });
  const transcript = useGetTranscriptQuery(id, { skip: !ready });
  const actions = useGetMeetingActionItemsQuery(id, { skip: !ready });
  const decisions = useGetDecisionsQuery(id, { skip: !ready });
  const risks = useGetRisksQuery(id, { skip: !ready });

  const [reprocess, reprocessState] = useReprocessMeetingMutation();
  const [remove, removeState] = useDeleteMeetingMutation();

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
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> {formatDuration(m.durationSeconds)}
            </span>
            <span>{formatDateTime(m.createdAt)}</span>
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
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Download className="h-4 w-4" /> Export
              </Button>
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

      {/* Audio player (synced with transcript) */}
      {ready && m.audioUrl && (
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

function SummaryPanel({
  meetingId,
  loading,
  summary,
}: {
  meetingId: string;
  loading: boolean;
  summary?: { shortSummary: string; detailedSummary: string; keyPoints: string[] };
}) {
  const [translate, { data: translated, isLoading: translating, reset }] = useTranslateSummaryMutation();
  const [lang, setLang] = React.useState("Spanish");

  async function onTranslate() {
    try {
      await translate({ id: meetingId, targetLanguage: lang }).unwrap();
    } catch {
      toast.error("Translation failed.");
    }
  }

  const view = translated ?? summary;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : view ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
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

        {/* Transcript lines */}
        {segments.length > 0 ? (
          <div className="space-y-1">
            {segments.map((s, i) => {
              const active = currentTime >= s.start && currentTime < s.end;
              return (
                <button
                  key={i}
                  onClick={() => onSeek(s.start)}
                  className={cn(
                    "flex w-full gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60",
                    active && "bg-primary/10"
                  )}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{timecode(s.start)}</span>
                  <span className="shrink-0 font-medium">{s.speaker}:</span>
                  <span>{s.text}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{fallbackText || "Transcript unavailable."}</p>
        )}
      </CardContent>
    </Card>
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
