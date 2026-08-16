"use client";

/**
 * Public, unauthenticated view of a shared meeting.
 *
 * Lives outside the `(app)` route group on purpose: no sidebar, no auth headers,
 * no RTK Query cache keyed to a signed-in user. It fetches the redacted payload
 * directly from the public endpoint, so a recipient with the link needs no
 * Recallix account.
 *
 * The page renders what it was given and never says what it was not. "The
 * summary was hidden from you" tells a recipient there is something worth
 * asking for; a section the owner withheld simply is not there, exactly as it
 * would not be for a meeting that has none.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { Mic, Link2Off, Clock, Lock, Loader2, Scissors } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatDuration, timecode } from "@/lib/format";
import type { SharedMeeting } from "@/lib/types";

type Status = "loading" | "ok" | "gone" | "locked";

export default function SharedMeetingPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [status, setStatus] = React.useState<Status>("loading");
  const [meeting, setMeeting] = React.useState<SharedMeeting | null>(null);
  const [password, setPassword] = React.useState("");
  const [wrong, setWrong] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  /**
   * The password travels in a header, never the query string: a URL is written
   * to server logs, browser history and any proxy in between.
   */
  const load = React.useCallback(
    async (secret?: string): Promise<Status> => {
      try {
        const res = await fetch(`${API_BASE}/public/shared/${encodeURIComponent(token)}`, {
          headers: secret ? { "X-Share-Password": secret } : undefined,
        });
        if (res.status === 401) return "locked";
        if (!res.ok) throw new Error(String(res.status));
        setMeeting((await res.json()) as SharedMeeting);
        return "ok";
      } catch {
        // Revoked, expired and never-existed are intentionally indistinguishable.
        return "gone";
      }
    },
    [token],
  );

  React.useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim() || checking) return;
    setChecking(true);
    setWrong(false);
    const next = await load(password);
    setChecking(false);
    if (next === "ok") setStatus("ok");
    else setWrong(true);
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mic className="h-3.5 w-3.5" />
          </div>
          <span className="font-semibold">Recallix AI</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {meeting?.startSeconds != null ? "Shared moment" : "Shared meeting"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        {status === "loading" && (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {status === "locked" && (
          <Card>
            <CardContent className="py-12">
              <form onSubmit={unlock} className="mx-auto flex max-w-sm flex-col items-center gap-3">
                <Lock className="h-8 w-8 text-muted-foreground" />
                <p className="font-medium">This link is password protected</p>
                <p className="text-center text-sm text-muted-foreground">
                  Whoever sent it to you will have the password.
                </p>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="Password"
                  placeholder="Password"
                  autoFocus
                />
                {wrong && <p className="text-sm text-destructive">That password is not right.</p>}
                <Button type="submit" disabled={checking || !password.trim()} className="w-full gap-2">
                  {checking && <Loader2 className="h-4 w-4 animate-spin" />}
                  Open
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {status === "gone" && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <Link2Off className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">This link is no longer available</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                It may have been revoked by its owner or expired. Ask whoever
                shared it for a new link.
              </p>
            </CardContent>
          </Card>
        )}

        {status === "ok" && meeting && (
          <>
            <div>
              <h1 className="text-2xl font-semibold">{meeting.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatDateTime(meeting.meetingDate)}
                {meeting.durationSeconds ? ` · ${formatDuration(meeting.durationSeconds)}` : ""}
                {meeting.startSeconds != null && (
                  <>
                    {" · "}
                    <span className="inline-flex items-center gap-1">
                      <Scissors className="h-3.5 w-3.5" />
                      excerpt from {timecode(meeting.startSeconds)}
                    </span>
                  </>
                )}
              </p>
            </div>

            {meeting.audioUrl && (
              <ClippedAudio
                src={meeting.audioUrl}
                start={meeting.startSeconds ?? null}
                end={meeting.endSeconds ?? null}
              />
            )}

            {meeting.shortSummary && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p>{meeting.shortSummary}</p>
                  {meeting.detailedSummary &&
                    meeting.detailedSummary !== meeting.shortSummary && (
                      <p className="text-muted-foreground">{meeting.detailedSummary}</p>
                    )}
                  {meeting.keyPoints?.length > 0 && (
                    <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
                      {meeting.keyPoints.map((k, i) => (
                        <li key={i}>{k}</li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {meeting.actionItems?.length > 0 && (
              <Section title="Action items" icon={Clock}>
                {meeting.actionItems.map((a, i) => (
                  <li key={i}>
                    <span className="font-medium">{a.title}</span>
                    <span className="text-muted-foreground">
                      {a.ownerName ? ` · ${a.ownerName}` : ""}
                      {a.dueDate ? ` · due ${a.dueDate}` : ""}
                    </span>
                  </li>
                ))}
              </Section>
            )}

            {meeting.transcript && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {meeting.startSeconds != null ? "What was said" : "Transcript"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {meeting.transcript}
                  </p>
                </CardContent>
              </Card>
            )}

            <p className="pt-4 text-center text-xs text-muted-foreground">
              Shared read-only via Recallix AI
            </p>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * The recording, bounded to the shared excerpt.
 *
 * <p>A plain {@code <audio>} rather than the app's transport: this page has no
 * transcript to drive one, and a recipient wants play and a scrubber, not
 * skip-silence. What it does add is the bound — the file behind a moment link is
 * still the whole meeting, so the player starts at the excerpt and stops at the
 * end of it rather than carrying on into an hour nobody was sent.
 */
function ClippedAudio({
  src,
  start,
  end,
}: {
  src: string;
  start: number | null;
  end: number | null;
}) {
  const ref = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || start == null) return;

    const seekToStart = () => {
      if (el.currentTime < start) el.currentTime = start;
    };
    const stopAtEnd = () => {
      if (end != null && el.currentTime >= end) {
        el.pause();
        el.currentTime = start;
      }
    };
    el.addEventListener("loadedmetadata", seekToStart);
    el.addEventListener("timeupdate", stopAtEnd);
    return () => {
      el.removeEventListener("loadedmetadata", seekToStart);
      el.removeEventListener("timeupdate", stopAtEnd);
    };
  }, [start, end]);

  return (
    <Card>
      <CardContent className="py-4">
        <audio ref={ref} src={src} controls preload="metadata" className="w-full" />
        {start != null && end != null && (
          <p className="mt-2 text-xs text-muted-foreground">
            {timecode(start)} – {timecode(end)} of the recording
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-primary" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">{children}</ul>
      </CardContent>
    </Card>
  );
}
