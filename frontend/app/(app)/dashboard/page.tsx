"use client";

import Link from "next/link";
import { Upload, FileAudio, ListChecks, Gauge, ArrowRight } from "lucide-react";
import {
  useGetMeetingsQuery,
  useGetActionItemsQuery,
  useGetUsageQuery,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatDuration } from "@/lib/format";

export default function DashboardPage() {
  const meetings = useGetMeetingsQuery({ page: 0, size: 5 });
  const openItems = useGetActionItemsQuery({ status: "OPEN", size: 1 });
  const usage = useGetUsageQuery();

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Your meetings, tasks and usage at a glance.</p>
        </div>
        <Button asChild>
          <Link href="/upload">
            <Upload className="h-4 w-4" /> Upload meeting
          </Link>
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<FileAudio className="h-5 w-5" />}
          label="Meetings this period"
          value={usage.data ? `${usage.data.meetingsUsed}` : undefined}
          hint={usage.data ? limitText(usage.data.meetingsUsed, usage.data.meetingsLimit) : ""}
        />
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label="Open action items"
          value={openItems.data ? `${openItems.data.totalElements}` : undefined}
          hint="Across all meetings"
        />
        <StatCard
          icon={<Gauge className="h-5 w-5" />}
          label="AI minutes used"
          value={usage.data ? `${usage.data.aiMinutesUsed}` : undefined}
          hint={usage.data ? limitText(usage.data.aiMinutesUsed, usage.data.aiMinutesLimit, "min") : ""}
        />
      </div>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Plan usage
            {usage.data && <span className="text-sm font-normal text-muted-foreground">{usage.data.plan}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {usage.data ? (
            <>
              <UsageBar label="Meetings" used={usage.data.meetingsUsed} limit={usage.data.meetingsLimit} />
              <UsageBar label="AI minutes" used={usage.data.aiMinutesUsed} limit={usage.data.aiMinutesLimit} />
            </>
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
          <Button variant="outline" size="sm" asChild>
            <Link href="/billing">Manage plan</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Recent meetings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Recent meetings
            <Link href="/search" className="text-sm font-normal text-primary hover:underline">
              View all
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {meetings.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : meetings.data && meetings.data.content.length > 0 ? (
            <ul className="divide-y">
              {meetings.data.content.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/meetings/${m.id}`}
                    className="flex items-center justify-between gap-3 py-3 transition-colors hover:bg-accent/50 -mx-2 px-2 rounded-md"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(m.createdAt)} · {formatDuration(m.durationSeconds)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={m.status} />
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value?: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          {value === undefined ? (
            <Skeleton className="mt-1 h-7 w-12" />
          ) : (
            <p className="text-2xl font-bold">{value}</p>
          )}
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">{unlimited ? `${used} / ∞` : `${used} / ${limit}`}</span>
      </div>
      <Progress value={unlimited ? 4 : pct} />
    </div>
  );
}

function limitText(used: number, limit: number, unit = ""): string {
  if (limit < 0) return "Unlimited";
  return `${limit - used} ${unit} remaining`.trim();
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <FileAudio className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-3 font-medium">No meetings yet</p>
      <p className="text-sm text-muted-foreground">Upload your first recording to get started.</p>
      <Button className="mt-4" asChild>
        <Link href="/upload">
          <Upload className="h-4 w-4" /> Upload meeting
        </Link>
      </Button>
    </div>
  );
}
