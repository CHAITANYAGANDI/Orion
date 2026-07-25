"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ListChecks } from "lucide-react";
import { useGetActionItemsQuery, usePatchActionItemMutation } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PriorityBadge, ActionStatusBadge } from "@/components/status-badge";
import type { ActionItemResponse, ActionItemStatus, Priority } from "@/lib/types";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Done" },
];
const PRIORITY_FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "All priorities" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export default function ActionItemsPage() {
  const [status, setStatus] = React.useState("ALL");
  const [priority, setPriority] = React.useState("ALL");

  const { data, isLoading } = useGetActionItemsQuery({
    status: status === "ALL" ? undefined : (status as ActionItemStatus),
    priority: priority === "ALL" ? undefined : (priority as Priority),
    size: 100,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Action items</h1>
          <p className="text-sm text-muted-foreground">Every task extracted across your meetings.</p>
        </div>
        <div className="flex gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_FILTERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data && data.content.length > 0 ? (
            <ul className="divide-y">
              {data.content.map((item) => (
                <ActionItemRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ListChecks className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium">No action items</p>
              <p className="text-sm text-muted-foreground">Process a meeting to see extracted tasks here.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ActionItemRow({ item }: { item: ActionItemResponse }) {
  const [patch, { isLoading }] = usePatchActionItemMutation();

  async function update(body: Partial<Pick<ActionItemResponse, "status" | "priority">>) {
    try {
      await patch({ id: item.id, body }).unwrap();
    } catch {
      toast.error("Update failed.");
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">
          {item.ownerName || "Unassigned"}
          {item.dueDate ? ` · due ${item.dueDate}` : ""}
          {item.meetingTitle ? (
            <>
              {" · "}
              <Link href={`/meetings/${item.meetingId}`} className="text-primary hover:underline">
                {item.meetingTitle}
              </Link>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <PriorityBadge priority={item.priority} />
        <Select value={item.status} onValueChange={(v) => update({ status: v as ActionItemStatus })} disabled={isLoading}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue>
              <ActionStatusBadge status={item.status} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="IN_PROGRESS">In progress</SelectItem>
            <SelectItem value="DONE">Done</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </li>
  );
}
