"use client";

import * as React from "react";
import Link from "next/link";
import { Search as SearchIcon, ArrowRight, Sparkles, Type } from "lucide-react";
import { useGetMeetingsQuery, useSemanticSearchMutation } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatDuration, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MeetingStatus } from "@/lib/types";

const STATUSES = ["ALL", "READY", "TRANSCRIBING", "SUMMARIZING", "EXTRACTING", "QUEUED", "FAILED"];

/**
 * Two ways to find a meeting:
 *  - "title"   — keyword + status filtering, served by GET /meetings
 *  - "meaning" — semantic search over transcript embeddings, which finds
 *                meetings by what was *said* rather than what they were called
 */
type Mode = "title" | "meaning";

export default function SearchPage() {
  const [raw, setRaw] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("ALL");
  const [page, setPage] = React.useState(0);
  const [mode, setMode] = React.useState<Mode>("title");

  // Debounce the text input.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setSearch(raw);
      setPage(0);
    }, 350);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isLoading, isFetching } = useGetMeetingsQuery(
    {
      page,
      size: 20,
      search: search || undefined,
      status: status === "ALL" ? undefined : (status as MeetingStatus),
    },
    { skip: mode !== "title" }
  );

  const [runSemantic, semantic] = useSemanticSearchMutation();

  // Semantic search is a mutation (it posts a query), so fire it whenever the
  // debounced term changes while in meaning mode.
  React.useEffect(() => {
    if (mode !== "meaning") return;
    const query = search.trim();
    if (!query) return;
    void runSemantic({ query, limit: 20 });
  }, [mode, search, runSemantic]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Search meetings</h1>
        <p className="text-sm text-muted-foreground">
          Find past decisions, tasks and summaries — by title, or by what was actually said.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={
              mode === "title"
                ? "Search by title…"
                : "Describe what was discussed — e.g. “the budget pushback from finance”"
            }
            className="pl-9"
          />
        </div>

        {mode === "title" && (
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "ALL" ? "All statuses" : s.charAt(0) + s.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <Card>
        <CardContent className="pt-6">
          {mode === "meaning" ? (
            <MeaningResults
              query={search.trim()}
              loading={semantic.isLoading}
              hits={semantic.data}
            />
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : data && data.content.length > 0 ? (
            <>
              <ul className="divide-y">
                {data.content.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/meetings/${m.id}`}
                      className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-accent/50"
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

              {data.totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Page {data.page + 1} of {data.totalPages} · {data.totalElements} total
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((p) => p - 1)}>
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= data.totalPages - 1 || isFetching}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">No meetings match your search.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: { value: Mode; label: string; icon: typeof Type }[] = [
    { value: "title", label: "Title", icon: Type },
    { value: "meaning", label: "Meaning", icon: Sparkles },
  ];
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((o) => {
        const Icon = o.icon;
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function MeaningResults({
  query,
  loading,
  hits,
}: {
  query: string;
  loading: boolean;
  hits?: import("@/lib/types").SemanticSearchHit[];
}) {
  if (!query) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Describe a moment and Recallix will find the meetings where it happened —
        no exact wording needed.
      </p>
    );
  }
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (!hits || hits.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing in your transcripts matches that yet.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {hits.map((h) => (
        <li key={`${h.meetingId}-${h.chunkIndex}`}>
          <Link
            href={h.start != null ? `/meetings/${h.meetingId}?t=${h.start}` : `/meetings/${h.meetingId}`}
            className="-mx-2 block rounded-md px-2 py-3 transition-colors hover:bg-accent/50"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{h.meetingTitle}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(h.meetingCreatedAt)}
                  {h.start != null ? ` · at ${timecode(h.start)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                  title="Semantic similarity"
                >
                  {Math.round(h.score * 100)}% match
                </span>
                <StatusBadge status={h.meetingStatus} />
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">“{h.snippet}”</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
