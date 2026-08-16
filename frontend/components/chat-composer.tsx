"use client";

/**
 * The box you type a question into, and the two decisions that go with it.
 *
 * **What to look at.** By default the chat reads everything you own, which is
 * usually right and is occasionally the problem: "what did we decide about
 * pricing" across two years of calls answers from whichever passages sit closest
 * in embedding space. Naming three meetings, or a folder, turns a vague question
 * into an answerable one. That is what "Add context" is — not an attachment
 * mechanism, a narrowing.
 *
 * **How hard to look.** Express is the width the chat has always used. Advanced
 * retrieves more and asks the model to enumerate rather than summarise, which
 * costs proportionally more and is worth it for "list everything outstanding"
 * and wasted on "what did Priya say". The wording of both comes from the server
 * so it cannot drift from what they actually do.
 *
 * The textarea grows to a limit and submits on Enter, because a chat box that
 * needs a mouse to send is a chat box people stop using. Shift-Enter is the
 * newline, which is the convention everywhere this pattern appears.
 */

import * as React from "react";
import { AtSign, ArrowUp, ChevronDown, Loader2, X, Folder, FileAudio, Search } from "lucide-react";
import type { ChatMode, ChatModeOption, MeetingResponse, Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How tall the box is allowed to grow before it scrolls instead. */
const MAX_ROWS = 8;

export interface ChatContext {
  /** Meetings the question is narrowed to. Empty means the whole workspace. */
  meetingIds: string[];
  /** Folders the question is narrowed to; expanded to their meetings on send. */
  projectIds: string[];
}

export const NO_CONTEXT: ChatContext = { meetingIds: [], projectIds: [] };

export interface ChatComposerProps {
  placeholder?: string;
  busy?: boolean;
  /** Null hides the picker entirely — the project chat has no mode choice. */
  modes?: ChatModeOption[];
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;

  context: ChatContext;
  onContextChange: (context: ChatContext) => void;
  meetings: MeetingResponse[];
  projects: Project[];

  onSend: (question: string) => void | Promise<void>;
}

export function ChatComposer({
  placeholder = "Ask anything about your conversations",
  busy = false,
  modes,
  mode = "express",
  onModeChange,
  context,
  onContextChange,
  meetings,
  projects,
  onSend,
}: ChatComposerProps) {
  const [text, setText] = React.useState("");
  const [picking, setPicking] = React.useState(false);
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Grow with the content. Reset to auto first or the box can only ever get
  // taller — scrollHeight includes the height already set.
  React.useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 24;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, [text]);

  function submit() {
    const question = text.trim();
    if (!question || busy) return;
    setText("");
    void onSend(question);
  }

  const chosen = modes?.find((m) => m.mode === mode);
  const selectedCount = context.meetingIds.length + context.projectIds.length;

  return (
    <div className="relative rounded-xl border bg-card shadow-sm">
      {picking && (
        <ContextPicker
          meetings={meetings}
          projects={projects}
          context={context}
          onContextChange={onContextChange}
          onClose={() => setPicking(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          aria-expanded={picking}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            selectedCount > 0
              ? "border-primary bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          <AtSign className="h-3.5 w-3.5" />
          Add context
        </button>

        {context.projectIds.map((id) => (
          <Chip
            key={id}
            icon={<Folder className="h-3 w-3" />}
            label={projects.find((p) => p.id === id)?.name ?? "Folder"}
            onRemove={() =>
              onContextChange({
                ...context,
                projectIds: context.projectIds.filter((p) => p !== id),
              })
            }
          />
        ))}
        {context.meetingIds.map((id) => (
          <Chip
            key={id}
            icon={<FileAudio className="h-3 w-3" />}
            label={meetings.find((m) => m.id === id)?.title ?? "Conversation"}
            onRemove={() =>
              onContextChange({
                ...context,
                meetingIds: context.meetingIds.filter((m) => m !== id),
              })
            }
          />
        ))}
      </div>

      <textarea
        ref={areaRef}
        rows={1}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label="Ask a question"
        className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-2 px-3 pb-3">
        {modes && modes.length > 0 ? (
          <ModePicker
            modes={modes}
            value={mode}
            label={chosen?.label ?? "Express"}
            onChange={(next) => onModeChange?.(next)}
          />
        ) : (
          <span />
        )}

        <Button
          type="button"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          disabled={busy || !text.trim()}
          onClick={submit}
          aria-label="Send"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function Chip({
  icon,
  label,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="flex max-w-[180px] items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
      {icon}
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ModePicker({
  modes,
  value,
  label,
  onChange,
}: {
  modes: ChatModeOption[];
  value: ChatMode;
  label: string;
  onChange: (mode: ChatMode) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-lg border bg-popover shadow-lg"
        >
          {modes.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === value}
              onClick={() => {
                onChange(m.mode);
                setOpen(false);
              }}
              className={cn(
                "block w-full px-3 py-2.5 text-left transition-colors hover:bg-accent",
                m.mode === value && "bg-accent/60",
              )}
            >
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="block text-xs text-muted-foreground">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What to narrow the question to.
 *
 * Conversations and folders, because those are the two units a person thinks in
 * — "the last three standups" and "everything in Q4 planning". Picking a folder
 * is not shorthand for picking its meetings one by one: a folder that gains a
 * meeting tomorrow should still be the right answer, and the ids are expanded
 * when the question is asked rather than when the chip is added.
 */
function ContextPicker({
  meetings,
  projects,
  context,
  onContextChange,
  onClose,
}: {
  meetings: MeetingResponse[];
  projects: Project[];
  context: ChatContext;
  onContextChange: (context: ChatContext) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = React.useState("");
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const needle = filter.trim().toLowerCase();
  const shownMeetings = meetings
    .filter((m) => !needle || m.title.toLowerCase().includes(needle))
    .slice(0, 20);
  const shownProjects = projects.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle),
  );

  function toggle(kind: "meeting" | "project", id: string) {
    if (kind === "meeting") {
      const has = context.meetingIds.includes(id);
      onContextChange({
        ...context,
        meetingIds: has
          ? context.meetingIds.filter((m) => m !== id)
          : [...context.meetingIds, id],
      });
    } else {
      // One folder at a time, and choosing another replaces it. The limit comes
      // from how the folder's meetings are fetched — see useWorkspaceChat — and
      // is enforced here rather than silently ignored there. "These two folders
      // and nothing else" is answered by picking the meetings.
      const has = context.projectIds.includes(id);
      onContextChange({ ...context, projectIds: has ? [] : [id] });
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Add context"
      className="absolute bottom-full left-3 z-30 mb-2 w-80 overflow-hidden rounded-lg border bg-popover shadow-xl"
    >
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a conversation or folder"
          aria-label="Find a conversation or folder"
          className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {shownMeetings.length === 0 && shownProjects.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing matches that.
          </p>
        )}

        {shownMeetings.length > 0 && (
          <>
            <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Conversations
            </p>
            {shownMeetings.map((m) => (
              <PickerRow
                key={m.id}
                icon={<FileAudio className="h-3.5 w-3.5" />}
                label={m.title}
                selected={context.meetingIds.includes(m.id)}
                onClick={() => toggle("meeting", m.id)}
              />
            ))}
          </>
        )}

        {shownProjects.length > 0 && (
          <>
            <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Folders</p>
            {shownProjects.map((p) => (
              <PickerRow
                key={p.id}
                icon={<Folder className="h-3.5 w-3.5" />}
                label={p.name}
                selected={context.projectIds.includes(p.id)}
                onClick={() => toggle("project", p.id)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PickerRow({
  icon,
  label,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
        selected && "bg-primary/10 text-primary",
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <span className="shrink-0 text-xs">✓</span>}
    </button>
  );
}
