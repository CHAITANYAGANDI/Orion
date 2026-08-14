"use client";

/**
 * Workspace-wide "ask everything" chat.
 *
 * Unlike the per-meeting chat on the meeting detail page, retrieval here spans
 * every meeting the user owns, so citations carry the meeting they came from and
 * deep-link to that moment (`/meetings/{id}?t=seconds`).
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Sparkles,
  Send,
  Loader2,
  Quote,
  Trash2,
  MessagesSquare,
} from "lucide-react";
import {
  useGetWorkspaceChatQuery,
  useGetWorkspaceSuggestionsQuery,
  useAskWorkspaceChatMutation,
  useClearWorkspaceChatMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Citation } from "@/lib/types";
import { ChatSuggestions } from "@/components/chat-suggestions";
import { WORKSPACE_PROMPTS, toPrompts } from "@/lib/chat-prompts";

export default function AskPage() {
  const { data: messages, isLoading } = useGetWorkspaceChatQuery();
  // Generated from the user's recent meetings and cached server-side, so this
  // is a cheap read. Failure is silent by design: the chips fall back to the
  // static set rather than the page reporting that a convenience is missing.
  const { data: suggestions } = useGetWorkspaceSuggestionsQuery();
  const [ask, { isLoading: asking }] = useAskWorkspaceChatMutation();
  const [clear, { isLoading: clearing }] = useClearWorkspaceChatMutation();
  const [q, setQ] = React.useState("");
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setQ("");
    try {
      await ask({ question: trimmed }).unwrap();
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }

  async function onClear() {
    try {
      await clear().unwrap();
      toast.success("Conversation cleared.");
    } catch {
      toast.error("Couldn't clear the conversation.");
    }
  }

  const empty = !isLoading && (!messages || messages.length === 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Sparkles className="h-6 w-6 text-primary" /> Ask Recallix
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Grounded in every meeting you own — answers cite the exact moment
            they came from.
          </p>
        </div>
        {!empty && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={clearing}
            className="gap-2 shrink-0"
          >
            <Trash2 className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessagesSquare className="h-4 w-4 text-primary" /> Conversation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 max-h-[55vh] min-h-[240px] space-y-4 overflow-y-auto pr-1">
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-3/4" />
                <Skeleton className="h-16 w-2/3" />
              </div>
            ) : empty ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Ask a question that spans your meetings.
                </p>
                <div className="mx-auto mt-4 max-w-xl">
                  <ChatSuggestions
                    prompts={toPrompts(suggestions?.suggestions, WORKSPACE_PROMPTS)}
                    disabled={asking}
                    onSend={(prompt) => void send(prompt)}
                    onCompose={setQ}
                  />
                </div>
              </div>
            ) : (
              messages!.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <SourceList citations={msg.citations} />
                  </div>
                </div>
              ))
            )}
            {asking && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                  Searching across your meetings…
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(q);
            }}
            className="flex gap-2"
          >
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask anything about your meetings…"
              disabled={asking}
            />
            <Button type="submit" size="icon" disabled={asking || !q.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Citations grouped by meeting — a workspace answer usually pulls several
 * passages from the same call, and one chip per meeting reads better than one
 * chip per chunk.
 */
function SourceList({ citations }: { citations?: Citation[] }) {
  if (!citations || citations.length === 0) return null;

  const byMeeting = new Map<
    string,
    { title: string; stamps: { start: number; text: string }[] }
  >();

  for (const c of citations) {
    if (!c.meetingId) continue;
    const entry = byMeeting.get(c.meetingId) ?? {
      title: c.meetingTitle || "Untitled meeting",
      stamps: [],
    };
    if (c.start != null) entry.stamps.push({ start: c.start, text: c.text });
    byMeeting.set(c.meetingId, entry);
  }

  if (byMeeting.size === 0) return null;

  return (
    <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Sources
      </p>
      {Array.from(byMeeting.entries()).map(([meetingId, { title, stamps }]) => (
        <div key={meetingId} className="flex flex-wrap items-center gap-1.5">
          <Link
            href={`/meetings/${meetingId}`}
            className="text-[11px] font-medium underline underline-offset-2 hover:text-primary"
          >
            {title}
          </Link>
          {stamps.slice(0, 4).map((s, i) => (
            <Link
              key={i}
              href={`/meetings/${meetingId}?t=${s.start}`}
              title={s.text}
              className="inline-flex items-center gap-1 rounded-full bg-background/60 px-2 py-0.5 text-[11px] text-foreground hover:bg-background"
            >
              <Quote className="h-3 w-3" /> {timecode(s.start)}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
