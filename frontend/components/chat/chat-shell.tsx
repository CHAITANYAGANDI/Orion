"use client";

/**
 * The shape every Recallix chat has, with none of the data.
 *
 * Three surfaces ask questions — the rail beside the home list, the rail beside
 * a meeting, and the full-width AI Chat page — and until now each drew its own
 * version of the same thing. They had drifted: one centred its starter prompts
 * and one left-aligned them, and one wrapped the whole conversation in a `Card`
 * titled "Ask this meeting", so the panel was a box inside a box inside a rail.
 *
 * What is shared here is **presentation only**. The scopes stay apart on
 * purpose: workspace chat reads every meeting you own, meeting chat reads one,
 * and they are different endpoints with different conversation lists. Merging
 * them would be a data bug wearing a design fix. So these take rendered nodes
 * and callbacks, never a query.
 *
 * ## The layout, and why it is three fixed regions
 *
 *     ┌──────────────────────────┐
 *     │ header                   │  ← never scrolls: the thread picker
 *     ├──────────────────────────┤
 *     │ messages          ▲      │  ← the only thing that scrolls
 *     │                   │      │
 *     ├──────────────────────────┤
 *     │ suggestions              │  ← the dock
 *     │ composer                 │
 *     └──────────────────────────┘
 *
 * `min-h-0` on the middle region is what makes that work and is easy to lose:
 * a flex child defaults to `min-height: auto`, so a long conversation grows the
 * column instead of scrolling inside it, and the composer walks off the bottom
 * of the window. That was the old behaviour on the meeting page.
 */

import * as React from "react";
import { ChatSuggestions } from "@/components/chat-suggestions";
import type { ChatPrompt } from "@/lib/chat-prompts";
import { cn } from "@/lib/utils";

/**
 * Header, scrolling thread, docked composer.
 *
 * Takes the full height it is given and never more, so the page behind it does
 * not gain a scrollbar because somebody asked a lot of questions.
 */
export function ChatRail({
  header,
  dock,
  children,
  scrollRef,
  className,
}: {
  header: React.ReactNode;
  dock: React.ReactNode;
  children: React.ReactNode;
  /**
   * The scrolling region, handed back so a caller can keep the newest message
   * in view. It is this element and not a sentinel inside it: `scrollIntoView`
   * scrolls every scrollable ancestor including the document, which is how a
   * chat panel came to drag the whole page down as its history loaded.
   */
  scrollRef?: React.Ref<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="shrink-0 px-4 py-3">{header}</div>
      {/* min-h-0: without it this grows to fit its content and pushes the dock
          off the bottom instead of scrolling. */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {children}
      </div>
      <div className="shrink-0">{dock}</div>
    </div>
  );
}

/**
 * The bottom of a chat: what to ask, where answers come from, and the box.
 *
 * One region rather than three stacked ones. The starter prompts sit directly
 * above the input they fill in — they are a shortcut past an empty box, not the
 * panel's headline, and centring them in the middle of the thread put them
 * where the first answer was about to appear.
 *
 * They are shown only while the conversation is empty. A permanent row competes
 * with the thread and keeps offering "summarize this meeting" to somebody who
 * has the summary open.
 */
export function ChatDock({
  prompts,
  showPrompts,
  busy,
  onSend,
  onCompose,
  children,
  className,
}: {
  prompts: ChatPrompt[];
  /** Usually "the thread is empty". Kept as a prop so the caller decides. */
  showPrompts: boolean;
  busy?: boolean;
  onSend: (prompt: string) => void;
  onCompose: (prefix: string) => void;
  /** The composer, configured by whichever scope is rendering this. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2 px-4 pb-4", className)}>
      {showPrompts && (
        <ChatSuggestions
          prompts={prompts}
          disabled={busy}
          onSend={onSend}
          onCompose={onCompose}
        />
      )}

      {/* No standing notice about where answers come from. It said the same
          sentence on every visit to a panel whose whole subject is the
          meetings it is sitting next to, and a line of chrome that is never
          new is a line nobody reads and a line the composer is shorter for.
          What grounds an answer is the citations under it, which are specific,
          playable, and only there when there is something to say. */}
      {children}
    </div>
  );
}
