"use client";

/**
 * The search overlay: a box that answers.
 *
 * <p>It used to be a way of composing a query and handing it to /search. Which
 * meant that typing an ordinary word into it — the thing everybody does —
 * showed a blank panel, because the only thing it had to offer was completions
 * for filter prefixes. A search box that displays nothing while you type reads
 * as broken, and it was: the work was real and none of it was visible.
 *
 * <p>So it searches. Results appear under the box as the term settles, matched
 * conversations first and then the sentences that matched inside them, with the
 * term marked in both. Most searches end here, on the page you were already on,
 * which is the point of a search box in a header.
 *
 * <p><b>What it deliberately does not do.</b> No semantic search: that costs an
 * embedding per query and belongs on the page that can afford to be slower and
 * has room to label the results. No filter dropdowns: the four filters are
 * reachable as `when:`, `type:`, `tag:` and `in:`, and the box completes them
 * from what your workspace actually has. Anything more than a first page of
 * hits is what "See all results" is for — /search renders the same hits from
 * the same query, with the filters and the meaning search alongside.
 *
 * <p>The grammar is in `lib/search-query.ts`; the marking, the request and the
 * URL are all in `lib/search.ts`, shared with the results page. Two surfaces,
 * one search.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, X, Clock, Quote, ArrowRight } from "lucide-react";
import {
  useGetSearchFacetsQuery,
  useGetProjectsQuery,
  useSearchQuery,
} from "@/lib/api";
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
import {
  encodeState,
  meetingHref,
  snippet,
  toQueryArgs,
  totalResults,
} from "@/lib/search";
import { formatDateTime, formatDuration, timecode } from "@/lib/format";
import { Marked } from "@/components/marked-text";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SearchMeetingHit, SearchMentionHit } from "@/lib/types";

/** How long the typing has to stop before the archive is searched. */
const SETTLE_MS = 250;

/** A meeting or a sentence, flattened so one arrow key walks the whole list. */
type ResultRow =
  | { key: string; href: string; kind: "meeting"; hit: SearchMeetingHit }
  | { key: string; href: string; kind: "mention"; hit: SearchMentionHit };

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
  /** The text the results belong to, which lags the text being typed. */
  const [settled, setSettled] = React.useState(initial);
  /** Which result the arrow keys are on; -1 is "none, Enter opens the page". */
  const [active, setActive] = React.useState(-1);

  // Only fetched while the box is open. The facets are a workspace-wide
  // aggregate and there is no reason for every page in the app to pay for one.
  const { data: facets } = useGetSearchFacetsQuery(undefined, { skip: !open });
  const { data: projects } = useGetProjectsQuery(undefined, { skip: !open });

  React.useEffect(() => {
    if (open) {
      setText(initial);
      setSettled(initial);
      setCursor(initial.length);
      setHighlighted(0);
      setActive(-1);
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

  // Separate from the suggestions, which have to feel instant: completing
  // `tag:` is a local string operation, and a search across every transcript in
  // the workspace must not run once per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(text), SETTLE_MS);
    return () => clearTimeout(t);
  }, [text]);

  // A fresh list is a fresh selection. Leaving the highlight on row three while
  // the rows underneath it change would open whatever happened to land there.
  React.useEffect(() => setActive(-1), [settled]);

  const term = settled.trim();
  const searchState = React.useMemo(
    () => toSearchState(parseQuery(settled), catalog),
    [settled, catalog],
  );
  // `new Date()` is captured per state change rather than per render: a fresh
  // date every render is a fresh cache key, and the same search would refetch
  // for as long as the box stayed open.
  const args = React.useMemo(() => toQueryArgs(searchState, new Date()), [searchState]);
  const { data: found, isFetching } = useSearchQuery(args, { skip: !open || term === "" });

  const rows: ResultRow[] = React.useMemo(() => {
    if (!found) return [];
    return [
      ...found.meetings.hits.map((hit) => ({
        key: `meeting-${hit.id}`,
        href: meetingHref(hit.id),
        kind: "meeting" as const,
        hit,
      })),
      ...found.mentions.hits.map((hit) => ({
        key: `mention-${hit.segmentId}`,
        // Straight to the second it was said. A sentence you cannot jump to is
        // only an assertion that the word is in there somewhere.
        href: meetingHref(hit.meetingId, hit.start),
        kind: "mention" as const,
        hit,
      })),
    ];
  }, [found]);

  const total = term === "" ? 0 : totalResults(found);
  const searching = term !== "" && isFetching && rows.length === 0;

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

  /**
   * Open one hit.
   *
   * The search is remembered even though the results page was never reached:
   * what somebody typed is what they will want back tomorrow, and whether they
   * happened to find it on the first page does not change that.
   */
  function openResult(href: string) {
    setRecent(rememberSearch(userId, text));
    onOpenChange(false);
    router.push(href);
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
    if (rows.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      // Stops at both ends rather than wrapping. A list of results is a list of
      // answers in order, and wrapping from the last to the best is a way of
      // opening the wrong one while holding a key down.
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return Math.max(-1, Math.min(next, rows.length - 1));
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter completes a suggestion the user is looking at. Searching past an
      // open list would mean a half-typed `tag:q` silently becoming a free-text
      // search for "tag:q".
      if (suggestions.length > 0 && word.includes(":")) {
        choose(suggestions[highlighted]);
        return;
      }
      // Then it opens whatever is selected. Nothing selected means the whole
      // search, which is the results page.
      if (active >= 0 && rows[active]) {
        openResult(rows[active].href);
        return;
      }
      run();
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
              placeholder="Search conversations, transcripts, folders, tags"
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

          {/* Ordinary links in a list, not a second listbox. The suggestions
              below are the combobox's options; giving these the same role would
              tell a screen reader there are two lists of options for one input
              and leave the arrow keys unable to keep the promise. */}
          {term !== "" && (
            <div className="border-t">
              <div className="flex items-center justify-between px-4 py-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Results
                </p>
                <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {searching
                    ? "Searching…"
                    : `${total} result${total === 1 ? "" : "s"}`}
                </p>
              </div>

              {searching ? (
                <div className="space-y-2 px-4 pb-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">
                  No conversation or transcript contains those words. The full search also
                  looks for passages that <em>mean</em> this — open it below.
                </p>
              ) : (
                <ul className="max-h-[45vh] overflow-y-auto pb-1">
                  {rows.map((row, i) => (
                    <li key={row.key}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => openResult(row.href)}
                        className={cn(
                          "flex w-full items-start gap-3 px-4 py-2.5 text-left",
                          i === active ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        {row.kind === "meeting" ? (
                          <>
                            <Search className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                <Marked text={row.hit.title} query={searchState.q} />
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {formatDateTime(row.hit.createdAt)} ·{" "}
                                {formatDuration(row.hit.durationSeconds)}
                                {/* Why a title with none of the words in it is here. */}
                                {row.hit.mentions > 0 && (
                                  <span className="text-primary">
                                    {" "}
                                    · {row.hit.mentions} mention
                                    {row.hit.mentions === 1 ? "" : "s"}
                                  </span>
                                )}
                              </span>
                            </span>
                          </>
                        ) : (
                          <>
                            <Quote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm">
                                {row.hit.speaker && (
                                  <span className="font-medium">{row.hit.speaker}: </span>
                                )}
                                <span className="text-muted-foreground">
                                  <Marked
                                    text={snippet(row.hit.text, searchState.q, 60)}
                                    query={searchState.q}
                                  />
                                </span>
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {row.hit.meetingTitle}
                                {row.hit.start != null ? ` · ${timecode(row.hit.start)}` : ""}
                              </span>
                            </span>
                          </>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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

          {/* The way out to the page that can do more: every hit rather than the
              first few, the four filters as dropdowns, and the meaning search
              this overlay does not pay for. */}
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">
              {rows.length > 0 ? "↑↓ to choose · ⏎ to open" : "⏎ to search everything"}
            </span>
            <button
              type="button"
              onClick={() => run()}
              className="flex items-center gap-1.5 font-medium text-foreground hover:text-primary"
            >
              {total > rows.length && rows.length > 0
                ? `See all ${total} results`
                : "Search everything"}
              {rows.length > 0 ? (
                <ArrowRight className="h-3.5 w-3.5" />
              ) : (
                <CornerDownLeft className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
