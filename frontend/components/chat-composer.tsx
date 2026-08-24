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
 * **How hard to look.** Quick is the width the chat has always used. Thorough
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
import { useAllowance, aiRefusal } from "@/lib/allowance";

/** How tall the box is allowed to grow before it scrolls instead. */
const MAX_ROWS = 8;

/**
 * The typed line height in pixels, and the box's own vertical padding.
 *
 * Both are stated here because the ceiling is computed from them, and both must
 * match the classes on the textarea — `leading-6` and `py-1.5`. The old code
 * hardcoded 24 against a `text-sm` box whose line box is 20, so "eight rows"
 * was nearer ten.
 */
const LINE_HEIGHT = 24;
const PADDING_Y = 12;

/**
 * The tallest the box may get, after which it scrolls.
 *
 * Expressed as a real `max-height` rather than only as a number the resize
 * effect clamps to. The effect is one `useEffect` away from not running — a
 * ref that has not attached, text arriving from somewhere other than a
 * keystroke — and when it does not run there is nothing at all stopping the
 * box from growing until it has eaten the conversation above it. A CSS ceiling
 * holds whether or not any JavaScript does, and `overflow-y: auto` under it is
 * what puts a scrollbar there.
 */
const MAX_HEIGHT = MAX_ROWS * LINE_HEIGHT + PADDING_Y;

/**
 * The shortest it may ever be: one row.
 *
 * A floor, for the same reason there is a ceiling. The box is measured by
 * JavaScript, and a measurement taken while the panel is hidden — inside a
 * collapsed pane, or behind the Action Items tab — comes back as zero. Writing
 * zero back gave a box with no height, a placeholder nobody could read and a
 * caret nobody could see. CSS holds the floor whatever the measurement says.
 */
const MIN_HEIGHT = LINE_HEIGHT + PADDING_Y;

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

  context?: ChatContext;
  onContextChange?: (context: ChatContext) => void;
  meetings?: MeetingResponse[];
  projects?: Project[];

  /**
   * What this chat reads, when that is fixed and cannot be widened — meeting
   * chat reads one meeting and has no endpoint for anything else.
   *
   * Pass the thing's own name rather than a description of it. "This meeting"
   * is only meaningful while the meeting is on screen next to it, and the panel
   * can now be maximised over the page.
   *
   * Shown as a plain chip rather than the picker. An "Add context" button on a
   * chat that cannot take any would be a control that does nothing, which is
   * worse than not offering it: it invites somebody to try, twice.
   */
  scope?: string;

  /**
   * Text to drop into the box, from somewhere else on the page.
   *
   * Keyed on the nonce alone. The same passage can be asked about twice, and
   * depending on the text would silently swallow the second attempt.
   */
  compose?: { text: string; nonce: number } | null;

  onSend: (question: string) => void | Promise<void>;
}

export function ChatComposer({
  placeholder = "Ask anything about your conversations",
  busy = false,
  modes,
  mode = "express",
  onModeChange,
  context = NO_CONTEXT,
  onContextChange,
  meetings = [],
  projects = [],
  scope,
  compose,
  onSend,
}: ChatComposerProps) {
  const [text, setText] = React.useState("");
  const [picking, setPicking] = React.useState(false);
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (!compose) return;
    setText(compose.text);
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(compose.text.length, compose.text.length);
    // Deliberately only the nonce -- see the prop's own note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose?.nonce]);

  /*
   * Grow with the content.
   *
   * Reset to auto first or the box can only ever get taller — `scrollHeight`
   * includes the height already set. No clamping here: `max-height` and
   * `min-height` do that in CSS, and doing it in both places is two ceilings to
   * keep in step.
   */
  const resize = React.useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // An element that is not being displayed measures as zero, and writing
    // that back is how the box ended up invisible: the panel is portaled into
    // the shell's pane, which is `hidden` until a page claims it, so the very
    // first measurement happened while there was nothing to measure — and
    // nothing re-ran it afterwards, because the text had not changed.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, []);

  React.useEffect(resize, [text, resize]);

  /*
   * Measure again when the box changes width.
   *
   * Two cases, one observer. Coming back on screen is a width of zero becoming
   * a real one, and it is not a render of this component — the class that hid
   * it belongs to an ancestor — so nothing else would ever re-measure. And the
   * side panel can now be dragged, which rewraps every line in here; without
   * this the box keeps the height it needed at the old width and clips.
   *
   * The wrapper is observed rather than the textarea, and only its width is
   * acted on. Observing the box's own height would mean reacting to the height
   * this very callback sets, which is a loop.
   */
  React.useEffect(() => {
    const box = areaRef.current?.parentElement;
    if (!box) return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      resize();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [resize]);

  function submit() {
    const question = text.trim();
    if (!question || busy || shut) return;
    setText("");
    void onSend(question);
  }

  const allowance = useAllowance();
  // Read here rather than passed in by each of the four surfaces that mount a
  // composer. "Disable every AI chat" has to mean every one, and a prop is a
  // thing the fifth caller forgets.
  const refusal = aiRefusal(allowance, "chat");
  const shut = refusal !== null;

  const chosen = modes?.find((m) => m.mode === mode);
  const selectedCount = context.meetingIds.length + context.projectIds.length;

  return (
    /*
     * One box, three rows, one horizontal rule.
     *
     * The rows used to disagree about their own left edge — the chips at 12px,
     * the text at 16px, the mode picker back at 12px — so the placeholder
     * started a quarter-inch right of the chip above it and the whole box read
     * as slightly broken without it being obvious why. They are all `px-3.5`
     * now and everything in the box lines up.
     *
     * The ring is not decoration. The textarea sets `outline-none`, and until
     * now put nothing in its place: tabbing into the chat gave no indication of
     * having arrived anywhere.
     */
    <div className="relative rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
      {picking && !scope && (
        <ContextPicker
          meetings={meetings}
          projects={projects}
          context={context}
          onContextChange={onContextChange ?? (() => undefined)}
          onClose={() => setPicking(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-3">
        {scope ? (
          // Bounded and truncated, with the full name on hover: a meeting
          // title is whatever somebody called it, and an untruncated one wraps
          // the chip onto three lines and pushes the box off the panel.
          <span
            title={scope}
            className="flex max-w-[240px] items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
          >
            <AtSign className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{scope}</span>
          </span>
        ) : (
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
        )}

        {context.projectIds.map((id) => (
          <Chip
            key={id}
            icon={<Folder className="h-3 w-3" />}
            label={projects.find((p) => p.id === id)?.name ?? "Folder"}
            onRemove={() =>
              onContextChange?.({
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
              onContextChange?.({
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
        disabled={busy || shut}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={shut ? "AI Chat is closed" : placeholder}
        aria-label="Ask a question"
        // `leading-6` and `py-1.5` are the two numbers MAX_HEIGHT is built
        // from; changing either without the other moves the ceiling off a
        // whole number of lines and leaves a clipped half-line at the bottom.
        style={{ maxHeight: MAX_HEIGHT, minHeight: MIN_HEIGHT }}
        // `scrollbar-none` scrolls without drawing the bar — see globals.css.
        // On a box this small the bar is more furniture than the two lines it
        // is measuring, and the caret already says where you are.
        className="scrollbar-none block w-full resize-none overflow-y-auto bg-transparent px-3.5 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />

      {refusal && (
        <p className="px-3.5 pb-1 pt-0.5 text-xs text-muted-foreground">{refusal}</p>
      )}

      <div className="flex items-center justify-between gap-2 px-3.5 pb-3 pt-0.5">
        {modes && modes.length > 0 ? (
          <ModePicker
            modes={modes}
            value={mode}
            label={chosen?.label ?? "Quick"}
            onChange={(next) => onModeChange?.(next)}
          />
        ) : (
          <span />
        )}

        <Button
          type="button"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          disabled={busy || shut || !text.trim()}
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
        {/* Turns over when the list is showing. The menu opens *upwards* here
            -- there is no room under a composer sitting on the bottom of the
            window -- so pointing up while open points at it. Without this the
            arrow says "there is more below" over a list that is above. */}
        <ChevronDown
          className={cn("h-3 w-3 transition-transform duration-200", open && "rotate-180")}
        />
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
      className="absolute bottom-full left-3.5 z-30 mb-2 w-80 overflow-hidden rounded-lg border bg-popover shadow-xl"
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
