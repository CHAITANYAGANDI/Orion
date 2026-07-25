"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, Loader2, Mail, StickyNote, ListChecks, CalendarPlus, Check } from "lucide-react";
import {
  useGetMeetingsQuery,
  useGetAgentActionsQuery,
  usePlanAgentMutation,
  useApproveAgentActionMutation,
  useExecuteAgentActionMutation,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentAction, AgentActionStatus } from "@/lib/types";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CREATE_NOTION_NOTE: StickyNote,
  DRAFT_EMAIL: Mail,
  SEND_EMAIL: Mail,
  CREATE_TASKS: ListChecks,
  CREATE_CALENDAR_EVENT: CalendarPlus,
};

const STATUS_VARIANT: Record<AgentActionStatus, "secondary" | "default" | "success" | "destructive"> = {
  DRAFT: "secondary",
  APPROVED: "default",
  EXECUTED: "success",
  FAILED: "destructive",
  REJECTED: "destructive",
};

export default function AgentPage() {
  const meetings = useGetMeetingsQuery({ page: 0, size: 50 });
  const actions = useGetAgentActionsQuery();
  const [plan, planState] = usePlanAgentMutation();
  const [selected, setSelected] = React.useState<string>("");

  const readyMeetings = (meetings.data?.content ?? []).filter((m) => m.status === "READY");

  async function generate() {
    if (!selected) {
      toast.error("Pick a meeting first.");
      return;
    }
    try {
      await plan(selected).unwrap();
      toast.success("Draft actions created. Review and approve below.");
    } catch {
      toast.error("Could not generate a plan.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent actions</h1>
        <p className="text-sm text-muted-foreground">
          Turn a meeting into follow-ups. Everything is drafted first — you approve before anything runs.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-primary" /> Generate follow-ups
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-[280px]">
              <SelectValue placeholder="Select a processed meeting…" />
            </SelectTrigger>
            <SelectContent>
              {readyMeetings.length === 0 ? (
                <SelectItem value="none" disabled>
                  No processed meetings yet
                </SelectItem>
              ) : (
                readyMeetings.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.title}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button onClick={generate} disabled={planState.isLoading || !selected}>
            {planState.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            Generate plan
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Draft & executed actions</CardTitle>
        </CardHeader>
        <CardContent>
          {actions.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : actions.data && actions.data.length > 0 ? (
            <ul className="divide-y">
              {actions.data.map((a) => (
                <AgentActionRow key={a.id} action={a} />
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No agent actions yet. Generate follow-ups from a processed meeting above.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AgentActionRow({ action }: { action: AgentAction }) {
  const [approve, approveState] = useApproveAgentActionMutation();
  const [execute, executeState] = useExecuteAgentActionMutation();
  const Icon = ICONS[action.type] ?? Bot;

  async function onApprove() {
    try {
      await approve(action.id).unwrap();
      toast.success("Approved.");
    } catch {
      toast.error("Could not approve.");
    }
  }
  async function onExecute() {
    try {
      await execute(action.id).unwrap();
      toast.success("Executed.");
    } catch (e) {
      toast.error(msg(e) || "Could not execute.");
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="font-medium">{action.title || action.subject || action.type.replaceAll("_", " ")}</p>
          <p className="text-xs text-muted-foreground">
            {action.provider}
            {action.taskCount != null ? ` · ${action.taskCount} tasks` : ""}
            {" · "}
            <Link href={`/meetings/${action.meetingId}`} className="text-primary hover:underline">
              meeting
            </Link>
          </p>
          {action.body && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{action.body}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[action.status]}>{action.status}</Badge>
        {action.status === "DRAFT" && (
          <Button size="sm" variant="outline" onClick={onApprove} disabled={approveState.isLoading}>
            {approveState.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </Button>
        )}
        {action.status === "APPROVED" && (
          <Button size="sm" onClick={onExecute} disabled={executeState.isLoading}>
            {executeState.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Execute
          </Button>
        )}
      </div>
    </li>
  );
}

function msg(err: unknown): string | undefined {
  if (typeof err === "object" && err && "data" in err) {
    return (err as { data?: { message?: string } }).data?.message;
  }
  return undefined;
}
