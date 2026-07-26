"use client";

/**
 * Meeting Memory — the two things that only work because every meeting is
 * embedded in one space:
 *
 *  - Commitments: promises tracked across every meeting that followed, with the
 *    quote from the later meeting that justifies each status change.
 *  - Decision drift: decisions made weeks apart that contradict, supersede or
 *    reaffirm each other.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Brain,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Ghost,
  Quote,
  ArrowRight,
  Check,
  GitCompareArrows,
} from "lucide-react";
import {
  useGetCommitmentsQuery,
  usePatchCommitmentMutation,
  useGetDecisionDriftQuery,
  useAcknowledgeDriftMutation,
  useGetMemoryStatsQuery,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Commitment,
  CommitmentStatus,
  DecisionDrift,
  DriftRelation,
} from "@/lib/types";

const STATUS_FILTERS = ["ALL", "OPEN", "FULFILLED", "SLIPPED", "DROPPED", "CANCELLED"];

const STATUS_STYLE: Record<CommitmentStatus, { label: string; className: string; icon: typeof Clock }> = {
  OPEN: { label: "Open", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400", icon: Clock },
  FULFILLED: { label: "Fulfilled", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", icon: CheckCircle2 },
  SLIPPED: { label: "Slipped", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400", icon: AlertTriangle },
  CANCELLED: { label: "Cancelled", className: "bg-muted text-muted-foreground", icon: Ghost },
  DROPPED: { label: "Dropped", className: "bg-red-500/10 text-red-600 dark:text-red-400", icon: Ghost },
};

const RELATION_STYLE: Record<DriftRelation, { label: string; className: string }> = {
  CONTRADICTS: { label: "Contradicts", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  SUPERSEDES: { label: "Supersedes", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  REAFFIRMS: { label: "Reaffirms", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
};

export default function MemoryPage() {
  const { data: stats } = useGetMemoryStatsQuery();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Brain className="h-6 w-6 text-primary" /> Meeting memory
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you promised, whether it happened, and where your decisions changed
          their mind — tracked across every meeting.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatTile label="Open" value={stats.open} />
          <StatTile label="Fulfilled" value={stats.fulfilled} tone="good" />
          <StatTile label="Slipped" value={stats.slipped} tone="warn" />
          <StatTile label="Dropped" value={stats.dropped} tone="bad" />
          <StatTile label="Contradictions" value={stats.openContradictions} tone="bad" />
        </div>
      )}

      <Tabs defaultValue="commitments">
        <TabsList>
          <TabsTrigger value="commitments">Commitments</TabsTrigger>
          <TabsTrigger value="drift">Decision drift</TabsTrigger>
        </TabsList>
        <TabsContent value="commitments" className="mt-4">
          <CommitmentsTab />
        </TabsContent>
        <TabsContent value="drift" className="mt-4">
          <DriftTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p
          className={cn(
            "text-2xl font-semibold",
            tone === "good" && "text-emerald-600 dark:text-emerald-400",
            tone === "warn" && "text-amber-600 dark:text-amber-400",
            tone === "bad" && value > 0 && "text-red-600 dark:text-red-400"
          )}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ Commitments ------------------------------ */
function CommitmentsTab() {
  const [status, setStatus] = React.useState("ALL");
  const { data, isLoading } = useGetCommitmentsQuery({
    size: 50,
    status: status === "ALL" ? undefined : (status as CommitmentStatus),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const items = data?.content ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "ALL" ? "All statuses" : STATUS_STYLE[s as CommitmentStatus].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No commitments tracked yet. Action items become commitments once their
            meeting finishes processing — then every later meeting is checked
            against them automatically.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((c) => (
            <CommitmentCard key={c.id} commitment={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitmentCard({ commitment: c }: { commitment: Commitment }) {
  const [patch, { isLoading: saving }] = usePatchCommitmentMutation();
  const style = STATUS_STYLE[c.status] ?? STATUS_STYLE.OPEN;
  const Icon = style.icon;

  async function setStatus(next: CommitmentStatus) {
    try {
      await patch({ id: c.id, status: next }).unwrap();
      toast.success(`Marked ${STATUS_STYLE[next].label.toLowerCase()}.`);
    } catch {
      toast.error("Couldn't update the commitment.");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{c.text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {c.ownerName ? `${c.ownerName} · ` : ""}
              {c.dueDate ? `due ${c.dueDate} · ` : ""}
              promised in{" "}
              <Link
                href={`/meetings/${c.originMeetingId}`}
                className="underline underline-offset-2 hover:text-primary"
              >
                {c.originMeetingTitle || "a meeting"}
              </Link>
              {c.checksRun > 0
                ? ` · checked against ${c.checksRun} later meeting${c.checksRun === 1 ? "" : "s"}`
                : ""}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
              style.className
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {style.label}
          </span>
        </div>

        {c.evidence.length > 0 && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Evidence trail
            </p>
            {c.evidence.map((e) => (
              <div key={e.id} className="text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{e.verdict}</span>
                  <span className="text-muted-foreground">in</span>
                  <Link
                    href={
                      e.start != null
                        ? `/meetings/${e.meetingId}?t=${e.start}`
                        : `/meetings/${e.meetingId}`
                    }
                    className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary"
                  >
                    {e.meetingTitle || "a later meeting"}
                    {e.start != null && (
                      <>
                        <Quote className="h-3 w-3" />
                        {timecode(e.start)}
                      </>
                    )}
                  </Link>
                </div>
                {e.quote && (
                  <p className="mt-1 border-l-2 border-border pl-2 italic text-muted-foreground">
                    “{e.quote}”
                  </p>
                )}
                {e.rationale && (
                  <p className="mt-0.5 text-muted-foreground">{e.rationale}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(["FULFILLED", "SLIPPED", "OPEN", "CANCELLED"] as CommitmentStatus[])
            .filter((s) => s !== c.status)
            .map((s) => (
              <Button
                key={s}
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => void setStatus(s)}
              >
                Mark {STATUS_STYLE[s].label.toLowerCase()}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ----------------------------- Decision drift ---------------------------- */
function DriftTab() {
  const [includeAcknowledged, setIncludeAcknowledged] = React.useState(false);
  const { data, isLoading } = useGetDecisionDriftQuery(includeAcknowledged);
  const [acknowledge] = useAcknowledgeDriftMutation();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const links = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIncludeAcknowledged((v) => !v)}
        >
          {includeAcknowledged ? "Hide dismissed" : "Show dismissed"}
        </Button>
      </div>

      {links.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No decision drift detected. As you record more meetings, decisions that
            contradict or replace earlier ones will surface here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {links.map((l) => (
            <DriftCard
              key={l.id}
              link={l}
              onAcknowledge={async () => {
                try {
                  await acknowledge(l.id).unwrap();
                  toast.success("Dismissed.");
                } catch {
                  toast.error("Couldn't dismiss that.");
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DriftCard({
  link,
  onAcknowledge,
}: {
  link: DecisionDrift;
  onAcknowledge: () => void;
}) {
  const style = RELATION_STYLE[link.relation] ?? RELATION_STYLE.SUPERSEDES;

  return (
    <Card className={cn(link.acknowledged && "opacity-60")}>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
              style.className
            )}
          >
            <GitCompareArrows className="h-3.5 w-3.5" /> {style.label}
          </span>
          <div className="flex items-center gap-2">
            {link.similarity != null && (
              <span className="text-xs text-muted-foreground">
                {Math.round(link.similarity * 100)}% similar
              </span>
            )}
            {!link.acknowledged && (
              <Button variant="ghost" size="sm" onClick={onAcknowledge} className="gap-1">
                <Check className="h-3.5 w-3.5" /> Dismiss
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <DecisionSide
            text={link.earlierText}
            meetingId={link.earlierMeetingId}
            meetingTitle={link.earlierMeetingTitle}
            label="Earlier"
          />
          <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
          <DecisionSide
            text={link.laterText}
            meetingId={link.laterMeetingId}
            meetingTitle={link.laterMeetingTitle}
            label="Later"
          />
        </div>

        {link.rationale && (
          <p className="text-sm text-muted-foreground">{link.rationale}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Detected {formatDateTime(link.createdAt)}
        </p>
      </CardContent>
    </Card>
  );
}

function DecisionSide({
  text,
  meetingId,
  meetingTitle,
  label,
}: {
  text: string;
  meetingId: string;
  meetingTitle?: string | null;
  label: string;
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm">{text}</p>
      <Link
        href={`/meetings/${meetingId}`}
        className="mt-1 inline-block text-xs underline underline-offset-2 hover:text-primary"
      >
        {meetingTitle || "View meeting"}
      </Link>
    </div>
  );
}
