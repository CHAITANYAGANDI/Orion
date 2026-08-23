"use client";

import * as React from "react";
import type { ChatPrompt } from "@/lib/chat-prompts";
import { cn } from "@/lib/utils";

/**
 * Clickable starter prompts for a grounded chat.
 *
 * Shown only while the conversation is empty. A permanent row of suggestions
 * competes with the thread for attention and, worse, keeps offering "summarize
 * this meeting" to someone who already has the summary on screen.
 *
 * Rendered by the caller directly above the composer rather than in the middle
 * of the empty thread. The panel then reads bottom-up — input, then the
 * shortcuts into it — instead of putting a wall of chips where the
 * conversation is about to appear and pushing the first real answer down the
 * screen.
 *
 * A prompt ending in a space is an opening rather than a question — "Find every
 * discussion about " — so it is put in the input for the user to finish instead
 * of being sent. Sending it as-is would ask the model to search for nothing.
 *
 * <p>The chip used to append " …" to those, on top of labels that already ended
 * in one — so they rendered "Find every mention of… …". Both are gone. A chip
 * is a short phrase and nothing on it should look like text that ran out of
 * room; where an ellipsis is doing work it is in the label itself, once.
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
      {/* Left-aligned and quiet, directly above the box these prompts fill in.
          Centred under a "Try one of these" heading, they read as the page's
          main offer — which is wrong twice over: they are a shortcut past the
          empty input, not the point of the panel, and centring them puts the
          shortest chip furthest from the cursor that is about to be used. */}
      <p className="text-xs font-medium text-muted-foreground">Suggestions</p>
      <div className="flex flex-wrap gap-1.5">
        {prompts.map((p) => {
          const unfinished = p.prompt.endsWith(" ");
          return (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => (unfinished ? onCompose(p.prompt) : onSend(p.prompt))}
              className={cn(
                "rounded-full border px-3 py-1.5 text-left text-xs transition-colors",
                "hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                "text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
