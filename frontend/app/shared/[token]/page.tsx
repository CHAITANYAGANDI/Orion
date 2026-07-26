"use client";

/**
 * Public, unauthenticated view of a shared meeting.
 *
 * Lives outside the `(app)` route group on purpose: no sidebar, no auth headers,
 * no RTK Query cache keyed to a signed-in user. It fetches the redacted payload
 * directly from the public endpoint, so a recipient with the link needs no
 * Recallix account.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { Mic, Loader2, Link2Off, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { SharedMeeting } from "@/lib/types";

type Status = "loading" | "ok" | "gone";

export default function SharedMeetingPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [status, setStatus] = React.useState<Status>("loading");
  const [meeting, setMeeting] = React.useState<SharedMeeting | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/public/shared/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as SharedMeeting;
        if (!cancelled) {
          setMeeting(data);
          setStatus("ok");
        }
      } catch {
        // Revoked, expired and never-existed are intentionally indistinguishable.
        if (!cancelled) setStatus("gone");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Mic className="h-3.5 w-3.5" />
          </div>
          <span className="font-semibold">Recallix AI</span>
          <span className="ml-auto text-xs text-muted-foreground">Shared meeting</span>
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
                {meeting.participants?.length ? ` · ${meeting.participants.join(", ")}` : ""}
              </p>
            </div>

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

            {meeting.decisions?.length > 0 && (
              <Section title="Decisions" icon={CheckCircle2}>
                {meeting.decisions.map((d, i) => (
                  <li key={i} className="space-y-1">
                    <p className="font-medium">{d.decision}</p>
                    {d.sourceSentence && (
                      <p className="border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                        “{d.sourceSentence}”
                      </p>
                    )}
                  </li>
                ))}
              </Section>
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

            {meeting.risks?.length > 0 && (
              <Section title="Risks" icon={AlertTriangle}>
                {meeting.risks.map((r, i) => (
                  <li key={i}>
                    <span className="font-medium">{r.risk}</span>
                    {r.severity && (
                      <span className="text-muted-foreground"> · {r.severity}</span>
                    )}
                  </li>
                ))}
              </Section>
            )}

            {meeting.transcript && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Transcript</CardTitle>
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
