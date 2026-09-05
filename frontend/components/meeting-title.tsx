"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Pencil, Plus, X } from "lucide-react";
import { useUpdateMeetingMutation } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The meeting's name and tags, edited in place.
 *
 * Uploading asks for neither — a meeting is named after its file and tagged
 * later — so this is the only place either is set. That makes it a real surface
 * rather than a convenience: if it is broken or hard to find, every meeting
 * stays called `recording-1755084000000` forever.
 *
 * Title and tags are saved independently. They share an endpoint but never a
 * request, because sending both would make an unrelated in-progress tag edit
 * ride along with a rename and land whatever happened to be in the box.
 */
export function MeetingTitle({ id, title }: { id: string; title: string }) {
  const [update, { isLoading }] = useUpdateMeetingMutation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // The prop is the truth: a reprocess or a rename in another tab must not be
  // overwritten by a draft left in local state from a previous edit.
  React.useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function save() {
    const next = draft.trim();
    // An empty title would leave the meeting unfindable in a list, so an empty
    // box means "I changed my mind" rather than "call it nothing".
    if (!next || next === title) {
      setDraft(title);
      setEditing(false);
      return;
    }
    try {
      await update({ id, body: { title: next } }).unwrap();
      setEditing(false);
    } catch {
      toast.error("Couldn't rename the meeting.");
    }
  }

  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        {/* The one thing on the page competing for first read, so it is set at
            the title-l step rather than at an interface size. Sans, not serif:
            it is the document's name, not the document. */}
        <h1 className="text-title-l font-headline text-ink">{title}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Rename meeting"
          onClick={() => setEditing(true)}
          className="no-print mt-1 h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        ref={inputRef}
        value={draft}
        aria-label="Meeting title"
        disabled={isLoading}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        className="h-9 text-lg font-semibold"
      />
      <Button size="icon" variant="ghost" aria-label="Save title" onClick={save} disabled={isLoading}>
        <Check className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Cancel rename"
        onClick={() => {
          setDraft(title);
          setEditing(false);
        }}
        disabled={isLoading}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Tags, added and removed one at a time.
 *
 * The whole list is sent on every change because the endpoint takes a list, not
 * a delta — so this reads the current tags from props each time rather than
 * accumulating locally, and two quick edits cannot produce a list that never
 * existed.
 */
export function MeetingTags({ id, tags }: { id: string; tags: string[] }) {
  const [update, { isLoading }] = useUpdateMeetingMutation();
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  async function commit(next: string[]) {
    try {
      await update({ id, body: { tags: next } }).unwrap();
    } catch {
      toast.error("Couldn't save tags.");
    }
  }

  async function add() {
    const t = draft.trim();
    setDraft("");
    if (!t) {
      setAdding(false);
      return;
    }
    // Case-insensitive: "Sprint" and "sprint" filter to the same meetings, so
    // storing both would split one tag into two that look identical in a list.
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setAdding(false);
      return;
    }
    await commit([...tags, t]);
    setAdding(false);
  }

  return (
    <>
      {tags.map((t) => (
        <Badge key={t} variant="secondary" className="gap-1 pr-1">
          {t}
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            disabled={isLoading}
            onClick={() => commit(tags.filter((x) => x !== t))}
            className="no-print rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {adding ? (
        <Input
          ref={inputRef}
          value={draft}
          aria-label="New tag"
          placeholder="Tag name"
          disabled={isLoading}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          className="h-6 w-28 px-2 py-0 text-xs"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="no-print inline-flex items-center gap-0.5 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> Tag
        </button>
      )}
    </>
  );
}
