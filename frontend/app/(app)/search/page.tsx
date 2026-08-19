"use client";

import * as React from "react";
import Link from "next/link";
import { Search as SearchIcon, ArrowRight, Sparkles, Clock, Quote } from "lucide-react";
import {
  useGetProjectsQuery,
  useGetSearchFacetsQuery,
  useGetSummaryTemplatesQuery,
  useSearchQuery,
  useSemanticSearchMutation,
} from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { SearchFilters } from "@/components/search-filters";
import { Marked } from "@/components/marked-text";
import { formatDateTime, formatDuration, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  GROUPS,
  decodeState,
  encodeState,
  isBlank,
  meaningWorthShowing,
  meetingHref,
  snippet,
  toQueryArgs,
  totalResults,
  type GroupSelection,
  type SearchState,
  type ShownGroupKey,
} from "@/lib/search";
import type {
  SearchMeetingHit,
  SearchMentionHit,
  SearchResponse,
  SemanticSearchHit,
} from "@/lib/types";

/**
 * Workspace search.
 *
 * <p>The page is built around one claim: when you search a meeting archive you
 * do not know what kind of thing you are looking for. "Stripe" might be the
 * title of a conversation or one sentence forty minutes into an hour of audio —
 * and which of those it is, is the answer, not the question. So both are
 * searched at once and the counts are shown together; the grouping is what
 * tells you the term lives in the recordings rather than in the titles.
 *
 * <p><b>One box, and no modes.</b> Exact and meaning search used to be a toggle,
 * which asked somebody to decide, before searching, whether the words they were
 * about to type are the words that were said — the very thing they came here to
 * find out. Both now run on every search and the meaning results sit under the
 * exact ones, labelled as what they are. The cost is one embedding per settled
 * query, which is what the debounce on the box is protecting.
 *
 * <p>What this page deliberately no longer lists: people, decisions,
 * commitments and risks. Each was a fifth and sixth way of arriving at a
 * meeting you could already see, on a screen whose question is "where was this
 * discussed". They are still on the meeting, which is where they mean
 * something.
 */
export default function SearchPage() {
  // Read straight from the address bar rather than through `useSearchParams`:
  // that hook forces the route into a Suspense boundary at build time, and this
  // is a client page that only ever runs in a browser.
  const [state, setState] = React.useState<SearchState>(() =>
    decodeState(typeof window === "undefined" ? "" : window.location.search),
  );
  const [raw, setRaw] = React.useState(state.q);

  // Debounce the box; every other control commits immediately.
  React.useEffect(() => {
    const t = setTimeout(
      () => setState((s) => (s.q === raw ? s : { ...s, q: raw })),
      350,
    );
    return () => clearTimeout(t);
  }, [raw]);

  // Keep the URL current so a search can be reloaded, bookmarked or sent.
  // `replaceState` rather than a router push: typing a word should not put
  // fifteen entries in the back button.
  React.useEffect(() => {
    const url = `${window.location.pathname}${encodeState(state)}`;
    window.history.replaceState(null, "", url);
  }, [state]);

  const { data: facets } = useGetSearchFacetsQuery();
  const { data: templates } = useGetSummaryTemplatesQuery();
  // Projects are not a facet: a facet is a list of strings and a project filter
  // needs the id as well as the name.
  const { data: projects } = useGetProjectsQuery();
  const typeLabels = React.useMemo(
    () => Object.fromEntries((templates ?? []).map((t) => [t.slug, t.name])),
    [templates],
  );

  // `new Date()` is captured per state change, not per render: recomputing the
  // date bound on every render would change the cache key each time and refetch
  // the same search forever.
  const overviewArgs = React.useMemo(
    () => toQueryArgs({ ...state, group: "all" }, new Date()),
    [state],
  );
  const deepArgs = React.useMemo(() => toQueryArgs(state, new Date()), [state]);

  const overview = useSearchQuery(overviewArgs);
  const deep = useSearchQuery(deepArgs, { skip: state.group === "all" });
  const meaning = useMeaningSearch(state.q);

  // Counts always come from the overview, so opening one group does not blank
  // the other number.
  const counts = overview.data;
  const shown = state.group === "all" ? overview.data : deep.data;
  const loading =
    state.group === "all"
      ? overview.isLoading
      : deep.isLoading || overview.isLoading;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Search Recallix</h1>
        <p className="text-sm text-muted-foreground">
          Every conversation you have recorded, and every sentence said in one.
        </p>
      </div>

      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-label="Search"
          placeholder="Search titles, tags and everything anyone said…"
          className="pl-9"
        />
      </div>

      <SearchFilters
        state={state}
        facets={facets}
        typeLabels={typeLabels}
        projects={projects}
        onChange={setState}
      />

      {!isBlank(state) && (
        <GroupTabs
          selected={state.group}
          counts={counts}
          onSelect={(group) => setState((s) => ({ ...s, group }))}
        />
      )}

      {loading ? (
        <ResultSkeleton />
      ) : (
        <Results
          state={state}
          data={shown}
          meaning={meaning}
          onOpenGroup={(group) => setState((s) => ({ ...s, group }))}
        />
      )}
    </div>
  );
}

/** Below this, a query is not yet a thought worth paying to embed. */
const MIN_MEANING = 3;

/**
 * The same query, asked of the embeddings.
 *
 * <p>Runs alongside the exact search rather than behind a button, because the
 * two answer the same question by different means and only one of them survives
 * somebody remembering the gist of a meeting instead of its wording.
 *
 * <p>Still a mutation rather than a query: it embeds the text, so it runs when
 * the term settles rather than on every render that happens to re-subscribe.
 * The last result is kept on screen while the next is in flight — blanking the
 * section on every keystroke would make it flicker for the whole of a typed
 * word.
 */
function useMeaningSearch(query: string) {
  const [run, result] = useSemanticSearchMutation();
  const q = query.trim();
  const asked = q.length >= MIN_MEANING;

  React.useEffect(() => {
    if (q.length < MIN_MEANING) return;
    void run({ query: q, limit: 10 });
  }, [q, run]);

  return {
    hits: asked ? result.data ?? [] : [],
    loading: asked && result.isLoading,
  };
}

export type MeaningResult = ReturnType<typeof useMeaningSearch>;

// ---- chrome --------------------------------------------------------------- //

const GROUP_ICONS: Record<ShownGroupKey, typeof Clock> = {
  meetings: Clock,
  mentions: Quote,
};

/**
 * The counts, and the way into one group.
 *
 * A group with nothing in it stays visible rather than disappearing:
 * "Transcript mentions 0" is information — it says the term is in your titles
 * but was never said out loud — and a row that vanishes takes that answer with
 * it.
 */
function GroupTabs({
  selected,
  counts,
  onSelect,
}: {
  selected: GroupSelection;
  counts?: SearchResponse;
  onSelect: (g: GroupSelection) => void;
}) {
  const tabs: { key: GroupSelection; label: string; total: number }[] = [
    { key: "all", label: "All", total: totalResults(counts) },
    ...GROUPS.map((g) => ({
      key: g.key as GroupSelection,
      label: g.label,
      total: counts ? counts[g.key].total : 0,
    })),
  ];

  return (
    <div className="flex flex-wrap gap-1.5 border-b pb-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          aria-pressed={selected === t.key}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
            selected === t.key
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {t.label}
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
              t.total > 0
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {t.total}
          </span>
        </button>
      ))}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

// ---- results -------------------------------------------------------------- //

function Results({
  state,
  data,
  meaning,
  onOpenGroup,
}: {
  state: SearchState;
  data?: SearchResponse;
  meaning: MeaningResult;
  onOpenGroup: (g: ShownGroupKey) => void;
}) {
  if (isBlank(state)) return <Resting />;

  // Filtered against what the words already found. Nearest-neighbour search
  // always returns its ten nearest, however far away they are, and the two
  // closest to any word are usually the passages containing it — which the list
  // above is already showing. See lib/search.ts.
  const closeInMeaning = meaningWorthShowing(meaning.hits, state.q, data?.mentions.hits);

  // Both halves have to be empty before the page says so. The exact search
  // failing on wording is the ordinary case that the meaning search exists for,
  // and "nothing matches" printed over a list of things that do would be a lie
  // with the evidence directly underneath it.
  if (totalResults(data) === 0 && closeInMeaning.length === 0 && !meaning.loading) {
    return (
      <Card>
        <CardContent className="space-y-1 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing in your workspace matches{" "}
            {state.q ? <span className="font-medium">“{state.q}”</span> : "those filters"}.
          </p>
          <p className="text-xs text-muted-foreground">
            Recallix looked for those words and for the sense of them, in every title, tag
            and transcript.
          </p>
        </CardContent>
      </Card>
    );
  }

  const only = state.group !== "all" ? (state.group as ShownGroupKey) : null;
  const groups = only ? GROUPS.filter((g) => g.key === only) : GROUPS;

  return (
    <div className="space-y-6">
      {groups.map((g) => {
        const group = data?.[g.key];
        if (!group || (group.total === 0 && !only)) return null;

        return (
          <Section
            key={g.key}
            title={g.label}
            hint={g.hint}
            total={group.total}
            icon={GROUP_ICONS[g.key]}
            onSeeAll={
              !only && group.total > group.hits.length
                ? () => onOpenGroup(g.key)
                : undefined
            }
          >
            <GroupBody groupKey={g.key} data={data} query={state.q} />
          </Section>
        );
      })}

      {/* Only on the overview. Opening a group is a request to see all of that
          group, and a second list underneath it is not that. */}
      {!only && <MeaningResults hits={closeInMeaning} loading={meaning.loading} />}
    </div>
  );
}

/**
 * The page before anybody has searched.
 *
 * <p>This used to be a list of recent meetings, which is Home with a search box
 * over it: five rows nobody came here to read, in the one place where the answer
 * is always going to be something they type. What replaces it says what the box
 * reaches, because that is the thing that is not obvious — that a search here
 * goes through the words of every recording, and finds a conversation whose
 * wording was nothing like the question.
 */
function Resting() {
  return (
    <Card>
      <CardContent className="space-y-3 py-16 text-center">
        <SearchIcon className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">Search everything you have recorded</p>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          Titles, tags and every sentence anyone said. Recallix also matches on meaning, so
          a search finds the conversation even when the words in the room were not the
          words you typed.
        </p>
      </CardContent>
    </Card>
  );
}

function GroupBody({
  groupKey,
  data,
  query,
}: {
  groupKey: ShownGroupKey;
  data?: SearchResponse;
  query: string;
}) {
  if (!data) return null;
  switch (groupKey) {
    case "meetings":
      return <MeetingList hits={data.meetings.hits} query={query} />;
    case "mentions":
      return <MentionList hits={data.mentions.hits} query={query} />;
  }
}

function Section({
  title,
  hint,
  total,
  icon: Icon,
  onSeeAll,
  children,
}: {
  title: string;
  hint?: string;
  total?: number;
  icon?: typeof Clock;
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {title}
          {total != null && (
            <span className="text-xs font-normal text-muted-foreground">
              {total} result{total === 1 ? "" : "s"}
            </span>
          )}
        </h2>
        {onSeeAll ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onSeeAll}>
            See all {total}
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        ) : (
          hint && <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </div>
      <Card>
        <CardContent className="p-0">{children}</CardContent>
      </Card>
    </section>
  );
}

function Row({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li className="border-b last:border-0">
      <Link
        href={href}
        className="block px-4 py-3 transition-colors hover:bg-accent/50"
      >
        {children}
      </Link>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function MeetingList({ hits, query }: { hits: SearchMeetingHit[]; query: string }) {
  if (hits.length === 0) return <Empty>No meetings match.</Empty>;
  return (
    <ul>
      {hits.map((m) => (
        <Row key={m.id} href={meetingHref(m.id)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">
                <Marked text={m.title} query={query} />
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(m.createdAt)} · {formatDuration(m.durationSeconds)}
                {/* Why an unrelated-looking title is in the results. */}
                {m.mentions > 0 && (
                  <span className="text-primary">
                    {" "}
                    · {m.mentions} mention{m.mentions === 1 ? "" : "s"}
                  </span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {m.tags.slice(0, 2).map((t) => (
                <span
                  key={t}
                  className="hidden rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline"
                >
                  {t}
                </span>
              ))}
              <StatusBadge status={m.status} />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </Row>
      ))}
    </ul>
  );
}

/**
 * Individual utterances.
 *
 * <p>Each one links to its own second of the recording. A mention you cannot
 * jump to is just an assertion that the term is in there somewhere.
 */
function MentionList({ hits, query }: { hits: SearchMentionHit[]; query: string }) {
  if (hits.length === 0) return <Empty>Nothing was said matching that.</Empty>;
  return (
    <ul>
      {hits.map((m) => (
        <Row key={m.segmentId} href={meetingHref(m.meetingId, m.start)}>
          <p className="text-sm">
            {m.speaker && <span className="font-medium">{m.speaker}: </span>}
            <span className="text-muted-foreground">
              <Marked text={snippet(m.text, query)} query={query} />
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.meetingTitle} · {formatDateTime(m.meetingCreatedAt)}
            {m.start != null ? ` · ${timecode(m.start)}` : ""}
          </p>
        </Row>
      ))}
    </ul>
  );
}

// ---- meaning -------------------------------------------------------------- //

/** What the section is, in the six words there is room for. */
const MEANING_HINT = "passages about this, in whatever words were used";

/**
 * Semantic hits, under the exact ones.
 *
 * <p>Labelled rather than mixed in. A passage that does not contain the search
 * term, sitting unannounced in a list of ones that do, reads as a bug in the
 * search — the heading is what turns it into the feature it is.
 *
 * <p>Nothing at all when there is nothing to show — which, for a search whose
 * words were the right ones, is most of the time. An empty "Close in meaning"
 * under a full page of exact results would be reporting a failure of something
 * nobody asked for, and a populated one full of passages that merely came back
 * from the index reads as the page having stopped understanding the question.
 */
function MeaningResults({
  hits,
  loading,
}: {
  hits: SemanticSearchHit[];
  loading: boolean;
}) {
  if (hits.length === 0 && !loading) return null;

  return (
    <Section title="Close in meaning" hint={MEANING_HINT} icon={Sparkles}>
      {hits.length === 0 ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <ul>
          {hits.map((h: SemanticSearchHit) => (
            <Row key={`${h.meetingId}-${h.chunkIndex}`} href={meetingHref(h.meetingId, h.start)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{h.meetingTitle}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(h.meetingCreatedAt)}
                    {h.start != null ? ` · at ${timecode(h.start)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                    title="Semantic similarity"
                  >
                    {Math.round(h.score * 100)}% match
                  </span>
                  <StatusBadge status={h.meetingStatus} />
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">“{h.snippet}”</p>
            </Row>
          ))}
        </ul>
      )}
    </Section>
  );
}
