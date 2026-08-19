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
import { Search, CornerDownLeft, X, Clock } from "lucide-react";
import { useGetSearchFacetsQuery, useGetProjectsQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  clearRecentSearches,
  readRecentSearches,
  rememberSearch,
} from "@/lib/recent-searches";
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
  const { userId } = useAuth();
  const [recent, setRecent] = React.useState<string[]>([]);

  // Only fetched while the box is open. The facets are a workspace-wide
  // aggregate and there is no reason for every page in the app to pay for one.
  const { data: facets } = useGetSearchFacetsQuery(undefined, { skip: !open });
  const { data: projects } = useGetProjectsQuery(undefined, { skip: !open });

  React.useEffect(() => {
    if (open) {
      setText(initial);
      setCursor(initial.length);
      setHighlighted(0);
      // Read on open rather than on mount: this component is mounted by the
      // shell for the life of the tab, so a value read once would be the list
      // as it stood before every search made since.
      setRecent(readRecentSearches(userId));
      // A frame later: the input does not exist until this render commits.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initial, userId]);

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

  function run(query: string = text) {
    const parsed = parseQuery(query);
    // Resolved here rather than on the results page so a value that matches
    // nothing is dropped now, while the box that produced it is still open.
    const state = toSearchState(parsed, catalog);
    // Recorded as typed, filters and all, so `from:priya budget` comes back as
    // the search it was rather than as the word "budget".
    setRecent(rememberSearch(userId, query));
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

          {/* What was searched before, until there is something to complete.
              The four worked examples that used to sit here were a help page in
              a box somebody opened in order to type. This is the opposite: it
              is only ever the user's own words, it is empty until they have
              typed some, and the commonest reason to open a search box is to
              run something close to the last one. */}
          {suggestions.length === 0 && text.trim() === "" && recent.length > 0 && (
            <div className="py-2">
              <div className="flex items-center justify-between px-4 py-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recent searches
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearRecentSearches(userId);
                    setRecent([]);
                    inputRef.current?.focus();
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              <ul className="max-h-72 overflow-y-auto">
                {recent.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => run(q)}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent/60"
                    >
                      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{q}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestions.length > 0 && (
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
          )}

          <div className="flex items-center justify-end border-t px-4 py-2 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => run()}
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
