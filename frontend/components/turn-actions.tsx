"use client";

/**
 * The toolbar that appears over a turn when you point at it.
 *
 * The counterpart to {@link SelectionMenu}, and the split between them is the
 * unit each one acts on. Selecting words is how you act on a *passage* — this
 * sentence, half of that one — and everything on that menu needs to know which
 * words. Pointing at a turn is how you act on *what somebody said*, whole, and
 * none of these five need a selection: reacting, commenting, bookmarking,
 * copying and linking all take the turn as it stands. Making them selection
 * actions would mean dragging across a paragraph to do something that was never
 * about part of it.
 *
 * Hidden until hover, and that is not decoration. A transcript is for reading;
 * five icons rendered permanently beside every turn is a column of clutter
 * running down an hour of speech. Keyboard users get it through
 * `focus-within`, so it is reachable by tabbing without ever being reachable by
 * accident.
 */

import * as React from "react";
import {
  Bookmark,
  Copy,
  Link2,
  MessageSquarePlus,
  SmilePlus,
  ThumbsUp,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The palette behind "more reactions".
 *
 * Ten, not a full emoji keyboard. The whole value of reacting over writing a
 * note is that it costs one click, and a search field with two thousand
 * characters behind it costs more than typing the word would have. These are
 * the ones that mean something about a sentence somebody said: agreement,
 * praise, importance, confusion, disagreement, done.
 */
export const REACTIONS: { emoji: string; label: string }[] = [
  { emoji: "👍", label: "Agree" },
  { emoji: "👎", label: "Disagree" },
  { emoji: "❤️", label: "Love" },
  { emoji: "👏", label: "Praise" },
  { emoji: "😂", label: "Funny" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "⭐", label: "Important" },
  { emoji: "🔥", label: "Key moment" },
  { emoji: "❓", label: "Unclear" },
  { emoji: "✅", label: "Done" },
];

/** The one on the toolbar itself, so the commonest reaction costs no menu. */
const QUICK = "👍";

export interface TurnActionsProps {
  /**
   * Which turn this is — "Priya at 12:04".
   *
   * Announced once when a screen reader enters the group, so the five buttons
   * inside it do not each have to repeat it. Without this, tabbing through an
   * hour of transcript is two hundred identical runs of "React, More
   * reactions, Add a note here" with nothing saying which turn any of them
   * would act on.
   */
  context: string;
  /** Emoji already on this turn, so the toolbar can show them as pressed. */
  reactions: string[];
  bookmarked: boolean;
  /** Disables everything while a mark is saving, so a double click cannot double-save. */
  busy?: boolean;
  onReact: (emoji: string) => void;
  onBookmark: () => void;
  onComment: () => void;
  onCopy: () => void;
  onShare: () => void;
}

function Action({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        active && "text-primary",
      )}
    >
      {children}
    </button>
  );
}

export function TurnActions({
  context,
  reactions,
  bookmarked,
  busy,
  onReact,
  onBookmark,
  onComment,
  onCopy,
  onShare,
}: TurnActionsProps) {
  // Kept open past the pointer leaving the turn. Radix portals the menu, so
  // without this the toolbar it is anchored to fades out the moment the pointer
  // crosses into the menu and the menu is left floating over nothing.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const reacted = new Set(reactions);

  return (
    <div
      role="group"
      aria-label={`Actions for ${context}`}
      // `pointer-events-none` while hidden matters: the bar overlaps the
      // speaker row, and an invisible one that still swallowed clicks would
      // make the timestamp beside the name unclickable.
      className={cn(
        "absolute -top-3 right-0 z-20 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-md",
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover:pointer-events-auto group-hover:opacity-100",
        "focus-within:pointer-events-auto focus-within:opacity-100",
        pickerOpen && "pointer-events-auto opacity-100",
      )}
    >
      <Action
        label={reacted.has(QUICK) ? `Remove ${QUICK}` : `React ${QUICK}`}
        onClick={() => onReact(QUICK)}
        disabled={busy}
        active={reacted.has(QUICK)}
      >
        <ThumbsUp className={cn("h-4 w-4", reacted.has(QUICK) && "fill-current")} />
      </Action>

      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="More reactions"
            aria-label="More reactions"
            disabled={busy}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
              "disabled:pointer-events-none disabled:opacity-50",
              pickerOpen && "bg-accent text-foreground",
            )}
          >
            <SmilePlus className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto p-2">
          <div className="grid grid-cols-5 gap-1">
            {REACTIONS.map(({ emoji, label }) => (
              <button
                key={emoji}
                type="button"
                title={label}
                aria-label={reacted.has(emoji) ? `Remove ${label} reaction` : `React ${label}`}
                aria-pressed={reacted.has(emoji)}
                onClick={() => {
                  onReact(emoji);
                  setPickerOpen(false);
                }}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-accent",
                  reacted.has(emoji) && "bg-primary/15 ring-1 ring-primary/40",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
          {/* Said once, here, rather than on every chip. Reverie has one
              account per workspace, so there is nobody for a reaction to
              notify and nobody it could be aimed at — it is a one-click tag on
              a passage, and somebody who thinks otherwise is entitled to know
              before they use it to answer a colleague. */}
          <p className="mt-2 max-w-[13rem] px-1 text-[11px] leading-snug text-muted-foreground">
            Reactions are your own marks. They never appear in a shared link or
            an exported document — only in your own data export.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <Action label="Add a note here" onClick={onComment} disabled={busy}>
        <MessageSquarePlus className="h-4 w-4" />
      </Action>
      <Action
        label={bookmarked ? "Remove bookmark" : "Bookmark this moment"}
        onClick={onBookmark}
        disabled={busy}
        active={bookmarked}
      >
        <Bookmark className={cn("h-4 w-4", bookmarked && "fill-current")} />
      </Action>
      <Action label="Copy with attribution" onClick={onCopy}>
        <Copy className="h-4 w-4" />
      </Action>
      <Action label="Copy link to this moment" onClick={onShare}>
        <Link2 className="h-4 w-4" />
      </Action>
    </div>
  );
}

/**
 * The reactions on a turn, under the words they are about.
 *
 * Rendered from the saved marks rather than from local state, so a reaction
 * that failed to save does not sit there looking saved. Clicking one takes it
 * off, which is the only way to remove it — there is no menu, because the
 * gesture that added it in one click should not need three to undo.
 */
export function TurnReactions({
  reactions,
  onToggle,
  busy,
}: {
  reactions: string[];
  onToggle: (emoji: string) => void;
  busy?: boolean;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {reactions.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          disabled={busy}
          title={`Remove ${emoji}`}
          aria-label={`Remove ${emoji} reaction`}
          className="flex h-6 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 text-sm leading-none transition-colors hover:bg-primary/20 disabled:opacity-50"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
