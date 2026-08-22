"use client";

import * as React from "react";
import Link from "next/link";
import { Send, Loader2, Quote, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { timecode } from "@/lib/format";
import type { ChatConversation, ChatMessage, Citation } from "@/lib/types";
import { ChatSuggestions } from "@/components/chat-suggestions";
import { ChatHistory } from "@/components/chat-history";
import { ChatMessageBubble } from "@/components/chat-message";
import type { ChatPrompt } from "@/lib/chat-prompts";

/**
 * The chat panel, without knowing which chat it is.
 *
 * <p>Recallix now asks questions at three scopes — the workspace, one meeting,
 * one project — and all three are the same conversation: a history picker, a
 * transcript of turns with their sources, suggestions when it is empty, and a
 * box. Only what is being read differs, and that is the server's business.
 *
 * <p>So this takes data and callbacks rather than calling the API itself.
 * Hooks cannot be chosen conditionally, so a component that fetched for itself
 * would have to subscribe to every scope's queries and skip two of them; each
 * page wiring its own hooks keeps that honest and keeps this presentational.
 *
 * <p>The one piece of state that does live here is the text in the box, because
 * nothing outside the panel has any use for a half-typed question.
 */
export interface ScopedChatProps {
  messages?: ChatMessage[];
  conversations: ChatConversation[];
  /** Null means "whatever was last said here" — see the pages' effects. */
  conversationId: string | null;
  onSelectConversation: (id: string | null) => void;

  loading: boolean;
  asking: boolean;
  deleting?: boolean;
  starting?: boolean;

  /** Starter questions, shown only while the thread is empty. */
  prompts: ChatPrompt[];
  /** What to say above the suggestions. */
  emptyLine: string;
  /** What the spinner says while an answer is being written. */
  thinkingLine: string;
  placeholder: string;

  onSend: (question: string) => void | Promise<void>;
  onNewConversation: () => void | Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  onDeleteExchange: (messageId: string) => Promise<void>;
}

export function ScopedChat({
  messages,
  conversations,
  conversationId,
  onSelectConversation,
  loading,
  asking,
  deleting = false,
  starting = false,
  prompts,
  emptyLine,
  thinkingLine,
  placeholder,
  onSend,
  onNewConversation,
  onRename,
  onDeleteConversation,
  onDeleteExchange,
}: ScopedChatProps) {
  const [q, setQ] = React.useState("");
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setQ("");
    void onSend(trimmed);
  }

  const empty = !loading && (!messages || messages.length === 0);

  return (
    <>
      <ChatHistory
        conversations={conversations}
        activeId={conversationId}
        onSelect={onSelectConversation}
        onNew={() => void onNewConversation()}
        busy={starting}
        onRename={onRename}
        onDelete={onDeleteConversation}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessagesSquare className="h-4 w-4 text-primary" /> Conversation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 max-h-[55vh] min-h-[240px] space-y-4 overflow-y-auto pr-1">
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-3/4" />
                <Skeleton className="h-16 w-2/3" />
              </div>
            ) : empty ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">{emptyLine}</p>
                <div className="mx-auto mt-4 max-w-xl">
                  <ChatSuggestions
                    prompts={prompts}
                    disabled={asking}
                    onSend={submit}
                    onCompose={setQ}
                  />
                </div>
              </div>
            ) : (
              messages!.map((msg) => (
                <ChatMessageBubble
                  key={msg.id}
                  message={msg}
                  deleting={deleting}
                  onDelete={onDeleteExchange}
                >
                  <SourceList citations={msg.citations} />
                </ChatMessageBubble>
              ))
            )}
            {asking && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                  {thinkingLine}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(q);
            }}
            className="flex gap-2"
          >
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={placeholder}
              disabled={asking}
            />
            <Button type="submit" size="icon" disabled={asking || !q.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Citations grouped by meeting — an answer that spans meetings usually pulls
 * several passages from the same call, and one chip per meeting reads better
 * than one chip per chunk.
 */
export function SourceList({ citations }: { citations?: Citation[] }) {
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
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-muted"
            >
              <Quote className="h-3 w-3" /> {timecode(s.start)}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
