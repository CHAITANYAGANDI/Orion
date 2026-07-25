"use client";

import * as React from "react";
import Link from "next/link";
import { Search as SearchIcon, ArrowRight } from "lucide-react";
import { useGetMeetingsQuery } from "@/lib/api";
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
import { formatDateTime, formatDuration } from "@/lib/format";
import type { MeetingStatus } from "@/lib/types";

const STATUSES = ["ALL", "READY", "TRANSCRIBING", "SUMMARIZING", "EXTRACTING", "QUEUED", "FAILED"];

export default function SearchPage() {
  const [raw, setRaw] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("ALL");
  const [page, setPage] = React.useState(0);

  // Debounce the text input.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setSearch(raw);
      setPage(0);
    }, 350);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isLoading, isFetching } = useGetMeetingsQuery({
    page,
    size: 20,
    search: search || undefined,
    status: status === "ALL" ? undefined : (status as MeetingStatus),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Search meetings</h1>
        <p className="text-sm text-muted-foreground">Find past decisions, tasks and summaries.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Search by title…"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
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
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
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
                          {m.participants?.length ? ` · ${m.participants.join(", ")}` : ""}
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
