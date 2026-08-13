"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import type { ChatPrompt } from "@/lib/chat-prompts";
import { cn } from "@/lib/utils";

/**
 * Clickable starter prompts for a grounded chat.
 *
 * Shown only while the conversation is empty. A permanent row of suggestions
 * competes with the thread for attention and, worse, keeps offering "summarize
 * this meeting" to someone who already has the summary on screen.
 *
 * A prompt ending in a space is an opening rather than a question — "Find every
 * discussion about " — so it is put in the input for the user to finish instead
 * of being sent. Sending it as-is would ask the model to search for nothing.
 */
export function ChatSuggestions({
  prompts,
  disabled,
  onSend,
  onCompose,
}: {
  prompts: ChatPrompt[];
  disabled?: boolean;
  /** A complete question: send it. */
  onSend: (prompt: string) => void;
  /** An unfinished one: put it in the box and let the user finish typing. */
  onCompose: (prefix: string) => void;
}) {
  if (prompts.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" /> Try one of these
      </p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {prompts.map((p) => {
          const unfinished = p.prompt.endsWith(" ");
          return (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => (unfinished ? onCompose(p.prompt) : onSend(p.prompt))}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                "hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                "text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {p.label}
              {unfinished && <span aria-hidden="true"> …</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
