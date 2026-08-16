"use client";

import * as React from "react";
import Link from "next/link";
import {
  Search as SearchIcon,
  ArrowRight,
  Sparkles,
  Layers,
  Clock,
  User,
  Gavel,
  AlertTriangle,
  ListChecks,
  Quote,
} from "lucide-react";
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
import { formatDateTime, formatDuration, timecode } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  EMPTY_SEARCH,
  GROUPS,
  decodeState,
  encodeState,
  highlight,
  isBlank,
  meetingHref,
  snippet,
  toQueryArgs,
  totalResults,
  type GroupSelection,
  type SearchState,
} from "@/lib/search";
import type {
  SearchCommitmentHit,
  SearchGroupKey,
  SearchInsightHit,
  SearchMeetingHit,
  SearchMentionHit,
  SearchPersonHit,
  SearchResponse,
  SemanticSearchHit,
} from "@/lib/types";

/**
 * Workspace search.
 *
 * <p>The page is built around one claim: when you search a meeting archive you
 * do not know what kind of thing you are looking for. "Stripe" might be a
 * meeting, a decision, a promise someone made, or one sentence in an hour of
 * audio — and which of those it is, is the answer, not the question. So every
 * kind is searched at once and the counts are shown together; the grouping is
 * what tells you the term lives in the recordings rather than in the titles.
 *
 * <p><b>Two modes, not two pages.</b> Exact search and meaning search answer
 * different questions and cost different amounts — the second embeds the query,
 * which is a model call per keystroke if it is left running. Keeping meaning
 * behind a toggle means it happens when it is asked for, and the empty result
 * of an exact search is the natural place to offer it.
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

  const exact = state.mode === "everything";
  const overview = useSearchQuery(overviewArgs, { skip: !exact });
  const deep = useSearchQuery(deepArgs, { skip: !exact || state.group === "all" });

  // Counts always come from the overview, so opening one group does not blank
  // the other five numbers.
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
          Meetings, people, decisions, commitments and every sentence anyone said.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[260px] flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Search"
            placeholder={
              exact
                ? "Search everything…"
                : "Describe what was discussed — e.g. “the budget pushback from finance”"
            }
            className="pl-9"
          />
        </div>
        <ModeToggle
          mode={state.mode}
          onChange={(mode) => setState((s) => ({ ...s, mode, group: "all" }))}
        />
      </div>

      {exact && (
        <SearchFilters
          state={state}
          facets={facets}
          typeLabels={typeLabels}
          projects={projects}
          onChange={setState}
        />
      )}

      {exact && !isBlank(state) && (
        <GroupTabs
          selected={state.group}
          counts={counts}
          onSelect={(group) => setState((s) => ({ ...s, group }))}
        />
      )}

      {!exact ? (
        <MeaningPanel query={state.q} />
      ) : loading ? (
        <ResultSkeleton />
      ) : (
        <Results
          state={state}
          data={shown}
          onOpenGroup={(group) => setState((s) => ({ ...s, group }))}
          onMeaning={() => setState((s) => ({ ...s, mode: "meaning" }))}
        />
      )}
    </div>
  );
}

// ---- chrome --------------------------------------------------------------- //

function ModeToggle({
  mode,
  onChange,
}: {
  mode: SearchState["mode"];
  onChange: (m: SearchState["mode"]) => void;
}) {
  const options = [
    { value: "everything" as const, label: "Everything", icon: Layers },
    { value: "meaning" as const, label: "Meaning", icon: Sparkles },
  ];
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={mode === o.value}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
              mode === o.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const GROUP_ICONS: Record<SearchGroupKey, typeof Clock> = {
  meetings: Clock,
  people: User,
  decisions: Gavel,
  commitments: ListChecks,
  risks: AlertTriangle,
  mentions: Quote,
};

/**
 * The counts, and the way into one group.
 *
 * A group with nothing in it stays visible rather than disappearing: "Decisions
 * 0" is information — it says the term was discussed but nothing was settled —
 * and a row that vanishes takes that answer with it.
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

/** The search term, marked inside a result. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}

// ---- results -------------------------------------------------------------- //

function Results({
  state,
  data,
  onOpenGroup,
  onMeaning,
}: {
  state: SearchState;
  data?: SearchResponse;
  onOpenGroup: (g: SearchGroupKey) => void;
  onMeaning: () => void;
}) {
  const blank = isBlank(state);

  if (blank) {
    return (
      <Section
        title="Recent meetings"
        hint="Search, or filter, to look across decisions, commitments and transcripts"
      >
        <MeetingList hits={data?.meetings.hits ?? []} query="" />
      </Section>
    );
  }

  if (totalResults(data) === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing in your workspace matches{" "}
            {state.q ? <span className="font-medium">“{state.q}”</span> : "those filters"}.
          </p>
          {state.q && (
            <div>
              {/* Exact search fails on wording, not on subject: this is the one
                  moment where paying for an embedding is obviously worth it. */}
              <Button variant="outline" size="sm" onClick={onMeaning}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                Try searching by meaning
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const only = state.group !== "all" ? (state.group as SearchGroupKey) : null;
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
    </div>
  );
}

function GroupBody({
  groupKey,
  data,
  query,
}: {
  groupKey: SearchGroupKey;
  data?: SearchResponse;
  query: string;
}) {
  if (!data) return null;
  switch (groupKey) {
    case "meetings":
      return <MeetingList hits={data.meetings.hits} query={query} />;
    case "people":
      return <PeopleList hits={data.people.hits} query={query} />;
    case "decisions":
      return <InsightList hits={data.decisions.hits} query={query} />;
    case "risks":
      return <InsightList hits={data.risks.hits} query={query} />;
    case "commitments":
      return <CommitmentList hits={data.commitments.hits} query={query} />;
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
 * People.
 *
 * <p>Three numbers, because they answer different questions and one merged "8
 * results" would blur them: how much someone spoke, how often everyone else
 * said their name, and how much they owe. Somebody who has never attended a
 * meeting can still be the most mentioned person in the archive, and the one
 * who owes the most.
 *
 * <p>A count of zero is left out rather than printed. "0 commitments" reads as
 * a finding; a person who simply spoke should say only that.
 */
function PeopleList({ hits, query }: { hits: SearchPersonHit[]; query: string }) {
  if (hits.length === 0) return <Empty>Nobody by that name is in your meetings.</Empty>;
  return (
    <ul>
      {hits.map((p) => {
        const facts = [
          p.meetings > 0 && `spoke in ${p.meetings} meeting${p.meetings === 1 ? "" : "s"}`,
          p.mentions > 0 && `mentioned ${p.mentions} time${p.mentions === 1 ? "" : "s"}`,
          p.commitments > 0 &&
            `${p.commitments} commitment${p.commitments === 1 ? "" : "s"}`,
        ].filter(Boolean) as string[];

        return (
          <li key={p.name} className="border-b px-4 py-3 last:border-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                {p.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">
                  <Marked text={p.name} query={query} />
                </p>
                <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InsightList({ hits, query }: { hits: SearchInsightHit[]; query: string }) {
  if (hits.length === 0) return <Empty>Nothing recorded.</Empty>;
  return (
    <ul>
      {hits.map((i) => (
        <Row key={i.id} href={meetingHref(i.meetingId)}>
          <p className="text-sm">
            <Marked text={i.text} query={query} />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {i.meetingTitle} · {formatDateTime(i.meetingCreatedAt)}
          </p>
        </Row>
      ))}
    </ul>
  );
}

function CommitmentList({
  hits,
  query,
}: {
  hits: SearchCommitmentHit[];
  query: string;
}) {
  if (hits.length === 0) return <Empty>No commitments match.</Empty>;
  return (
    <ul>
      {hits.map((c) => (
        <Row key={c.id} href={meetingHref(c.meetingId)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={cn("text-sm", c.status === "DONE" && "text-muted-foreground line-through")}>
                <Marked text={c.title} query={query} />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.owner ? <Marked text={c.owner} query={query} /> : "Unassigned"}
                {c.dueDate ? ` · due ${c.dueDate}` : ""} · {c.meetingTitle}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                c.status === "DONE"
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/10 text-primary",
              )}
            >
              {c.status.replace("_", " ").toLowerCase()}
            </span>
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

/**
 * Semantic search, unchanged in behaviour and moved behind the toggle.
 *
 * <p>Still a mutation rather than a query: it embeds the text, so it runs when
 * the term settles rather than on every render that happens to re-subscribe.
 */
function MeaningPanel({ query }: { query: string }) {
  const [run, result] = useSemanticSearchMutation();

  React.useEffect(() => {
    const q = query.trim();
    if (!q) return;
    void run({ query: q, limit: 20 });
  }, [query, run]);

  return (
    <Card>
      <CardContent className="p-0">
        {!query.trim() ? (
          <Empty>
            Describe a moment and Recallix will find the meetings where it happened — no
            exact wording needed.
          </Empty>
        ) : result.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : !result.data || result.data.length === 0 ? (
          <Empty>Nothing in your transcripts matches that yet.</Empty>
        ) : (
          <ul>
            {result.data.map((h: SemanticSearchHit) => (
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
      </CardContent>
    </Card>
  );
}
