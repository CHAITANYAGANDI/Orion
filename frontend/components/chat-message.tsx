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
 *
 * ## Delete belongs to the question
 *
 * It used to be drawn under both halves, which put a bin under every answer —
 * and a bin under an answer reads as "delete this answer", which is not what it
 * does and not something the API can do. People pressed it expecting to clear a
 * bad reply and lost the question they had typed with it.
 *
 * On the question it is the same control saying the true thing: this is my
 * turn, remove it and what came back. The server pairs from either half, so
 * nothing about the request changed — only which bubble offers it.
 *
 * ## The two sides are not the same object
 *
 * They were, and it cost the answers. A question is short, belongs to the
 * person who typed it, and reads as an aside: right-aligned, in a tinted
 * bubble, capped at 85% so the alignment is visible. An answer is the thing
 * somebody came for — often a hundred words with a heading and a numbered
 * procedure in it — and putting that in the same container gives it a grey slab
 * the height of the rail, with the reading measure squeezed by a bubble that
 * exists to say "not yours".
 *
 * So an answer is set as a document: left-aligned, full width, no fill. The
 * distinction the eye needs is already carried by the alignment and the tint on
 * the other side. Its text goes through `Markdown`; the question stays plain,
 * for the reasons in that file.
 */

import * as React from "react";
import { toast } from "sonner";
import { Copy, Check, Trash2 } from "lucide-react";
import { Markdown } from "@/components/markdown";
import type { ChatMessage as Message } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How a prompt looks.
 *
 * Exported because the pending turn draws the same bubble before the message
 * exists — see `components/chat/pending-turn`. Two copies of this string is two
 * chances for the question to change shape at the moment it is persisted, which
 * would read as the app re-rendering somebody's question rather than keeping
 * it.
 */
export const PROMPT_BUBBLE =
  "rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground";

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
      // The markdown source, not the rendered text. Somebody copying a
      // procedure is usually pasting it somewhere that will render it too, and
      // a flattened version arrives as one paragraph with the numbers in it.
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <div className={cn("group/msg flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex min-w-0 flex-col",
          isUser ? "max-w-[85%] items-end" : "w-full items-start",
        )}
      >
        <div
          className={cn(
            "min-w-0 text-sm",
            isUser ? PROMPT_BUBBLE : "w-full",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <Markdown>{message.content}</Markdown>
          )}
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
          {/* The question only. See the note at the top: under an answer this
              same button reads as "delete this answer", which is neither what
              it does nor something the API offers. */}
          {onDelete && isUser && (
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
