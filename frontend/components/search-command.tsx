"use client";

/**
 * One search box for the whole product.
 *
 * The search page used to put eight dropdowns beside its input. That works when
 * you already know which control holds the thing you want, and it is the wrong
 * shape for how an archive is actually searched: you type "priya stripe" meaning
 * "the bits where Priya talked about Stripe", without having first decided that
 * one of those words is a speaker filter.
 *
 * So the filters moved into the text — see `lib/search-query.ts` for the grammar
 * — and this is the box that teaches it. Typing `fr` offers `from:`; typing
 * `from:pri` offers the speakers who exist. Nothing has to be memorised, and
 * nothing has to be spelled the way somebody else's transcript spelled it.
 *
 * The results still open on `/search`, which already knows how to render six
 * kinds of hit. This is an entry point, not a second results page.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, X } from "lucide-react";
import { useGetSearchFacetsQuery, useGetProjectsQuery } from "@/lib/api";
import {
  applySuggestion,
  describeTokens,
  parseQuery,
  suggestFor,
  toSearchState,
  wordAt,
  type Suggestion,
} from "@/lib/search-query";
import { encodeState } from "@/lib/search";
import { cn } from "@/lib/utils";

export interface SearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seed the box, so opening it on a search shows that search. */
  initial?: string;
}

export function SearchCommand({ open, onOpenChange, initial = "" }: SearchCommandProps) {
  const router = useRouter();
  const [text, setText] = React.useState(initial);
  const [cursor, setCursor] = React.useState(initial.length);
  const [highlighted, setHighlighted] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Only fetched while the box is open. The facets are a workspace-wide
  // aggregate and there is no reason for every page in the app to pay for one.
  const { data: facets } = useGetSearchFacetsQuery(undefined, { skip: !open });
  const { data: projects } = useGetProjectsQuery(undefined, { skip: !open });

  React.useEffect(() => {
    if (open) {
      setText(initial);
      setCursor(initial.length);
      setHighlighted(0);
      // A frame later: the input does not exist until this render commits.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initial]);

  const catalog = React.useMemo(() => ({ facets, projects }), [facets, projects]);
  const { word } = React.useMemo(() => wordAt(text, cursor), [text, cursor]);
  const suggestions = React.useMemo(
    () => suggestFor(word, catalog),
    [word, catalog],
  );
  const chips = React.useMemo(() => describeTokens(parseQuery(text)), [text]);

  React.useEffect(() => setHighlighted(0), [word]);

  if (!open) return null;

  function choose(suggestion: Suggestion) {
    const next = applySuggestion(text, cursor, suggestion);
    setText(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function run() {
    const parsed = parseQuery(text);
    // Resolved here rather than on the results page so a value that matches
    // nothing is dropped now, while the box that produced it is still open.
    const state = toSearchState(parsed, catalog);
    onOpenChange(false);
    router.push(`/search${encodeState(state)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
      return;
    }
    if (suggestions.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setHighlighted((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return (next + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      choose(suggestions[highlighted]);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter completes a suggestion the user is looking at, and searches
      // otherwise. Searching past an open list would mean a half-typed
      // `from:pri` silently becoming a free-text search for "from:pri".
      if (suggestions.length > 0 && word.includes(":")) {
        choose(suggestions[highlighted]);
      } else {
        run();
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
      onMouseDown={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="mx-auto mt-[10vh] w-full max-w-2xl px-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="overflow-hidden rounded-xl border bg-popover shadow-2xl">
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setCursor(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyUp={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              placeholder="Search conversations, people, folders, time frame"
              aria-label="Search"
              className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            {text && (
              <button
                type="button"
                onClick={() => {
                  setText("");
                  setCursor(0);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
              {chips.map((chip, i) => (
                <span
                  key={`${chip.label}-${i}`}
                  className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                >
                  {chip.label}: {chip.value}
                </span>
              ))}
            </div>
          )}

          {suggestions.length > 0 ? (
            <ul role="listbox" aria-label="Search suggestions" className="max-h-72 overflow-y-auto py-1">
              {suggestions.map((s, i) => (
                <li key={`${s.kind}-${s.insert}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlighted}
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => choose(s)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                      i === highlighted ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="font-medium">{s.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{s.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Hints />
          )}

          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              Try <code className="rounded bg-muted px-1">from:</code>{" "}
              <code className="rounded bg-muted px-1">in:</code>{" "}
              <code className="rounded bg-muted px-1">when:</code>{" "}
              <code className="rounded bg-muted px-1">tag:</code>
            </span>
            <button
              type="button"
              onClick={run}
              className="flex items-center gap-1.5 font-medium text-foreground hover:text-primary"
            >
              Search <CornerDownLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What the box can do, shown when there is nothing to complete.
 *
 * A search overlay that opens empty and silent teaches nobody the grammar it
 * depends on. Four examples cost a moment to read and replace a help page.
 */
function Hints() {
  return (
    <div className="px-4 py-4 text-sm">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Search everything at once
      </p>
      <ul className="space-y-1.5 text-muted-foreground">
        <li>
          <code className="rounded bg-muted px-1 text-foreground">stripe</code> — meetings,
          decisions, commitments and every sentence anyone said
        </li>
        <li>
          <code className="rounded bg-muted px-1 text-foreground">from:priya budget</code> —
          what one person said about something
        </li>
        <li>
          <code className="rounded bg-muted px-1 text-foreground">in:&quot;Q4 planning&quot;</code> —
          inside one folder
        </li>
        <li>
          <code className="rounded bg-muted px-1 text-foreground">when:week decided:yes</code> —
          what got settled recently
        </li>
      </ul>
    </div>
  );
}
