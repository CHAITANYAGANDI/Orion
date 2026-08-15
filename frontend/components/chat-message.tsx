"use client";

/**
 * One turn in a chat, with its actions.
 *
 * Shared by the meeting chat and the workspace chat. The bubbles were already
 * near-identical in both; the difference is only how citations are drawn — one
 * seeks the player, the other links to another meeting — so those come in as
 * children rather than being branched on here.
 *
 * Copy exists because the useful output of an AI chat is text somebody is about
 * to paste somewhere else, and selecting a bubble by dragging also picks up the
 * citation chips. Delete removes the whole exchange, not the single turn — see
 * `ChatService.deleteExchange` for why half of one is worse than none.
 */

import * as React from "react";
import { toast } from "sonner";
import { Copy, Check, Trash2 } from "lucide-react";
import type { ChatMessage as Message } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ChatMessageBubble({
  message,
  onDelete,
  deleting,
  children,
}: {
  message: Message;
  onDelete?: (messageId: string) => Promise<void>;
  deleting?: boolean;
  /** Citations, drawn by whichever chat owns this message. */
  children?: React.ReactNode;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = React.useState(false);

  // Cleared on unmount so a bubble deleted while the tick is showing does not
  // set state on a component that has gone.
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <div className={cn("group/msg flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
          {children}
        </div>

        {/* Under the bubble rather than inside it: a control inside gets picked
            up when the text is selected by dragging, which is exactly what
            somebody who wants to copy it does first. Hidden until hover so a
            conversation reads as a conversation, but always focusable. */}
        <div className="mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
          <button
            type="button"
            onClick={copy}
            aria-label={isUser ? "Copy prompt" : "Copy answer"}
            title={isUser ? "Copy prompt" : "Copy answer"}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          {onDelete && (
            <button
              type="button"
              disabled={deleting}
              aria-label="Delete this exchange"
              title="Delete this question and its answer"
              onClick={async () => {
                try {
                  await onDelete(message.id);
                } catch {
                  toast.error("Couldn't delete that exchange.");
                }
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
