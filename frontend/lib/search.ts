import type {
  SearchGroupKey,
  SearchMentionHit,
  SearchQueryArgs,
  SearchResponse,
  SemanticSearchHit,
} from "@/lib/types";

/**
 * The state behind the search page, and the arithmetic that turns it into a
 * request, a URL, and highlighted text.
 *
 * All of it is here rather than in the page for one reason: none of it needs a
 * DOM, and every piece of it is a rule that is easy to get subtly wrong and
 * impossible to notice by looking. "Last 7 days" that quietly means "since this
 * time last Tuesday", a highlighter that treats a searched-for bracket as a
 * regular expression, a URL that loses a filter on reload — each renders
 * perfectly and answers the wrong question.
 */

/**
 * The groups this page renders.
 *
 * A subset of what the API answers with. People, decisions, commitments and
 * risks were four more lists on a page whose question is "where was this
 * discussed" — and the answer to that is a conversation and the sentence inside
 * it. Each of the other four was the same meeting reached by a longer route.
 * They are still on the meeting itself, which is the place they mean something.
 */
export type ShownGroupKey = Extract<SearchGroupKey, "meetings" | "mentions">;

/** `all` is the overview: both groups at once, a few rows each. */
export type GroupSelection = ShownGroupKey | "all";

export type DatePreset =
  | "any"
  | "today"
  | "week"
  | "month"
  | "quarter"
  | "year";

/**
 * A search: a term, and four ways of narrowing it.
 *
 * Speaker, status, action owner and "settled a decision" are gone. Owner and
 * decisions only ever narrowed lists this page no longer draws, and a control
 * that cannot change what is on screen is worse than no control because it gets
 * tried. The other two went with them: eight dropdowns over two kinds of result
 * is a filter bar wider than its answer. What is left is what people reach for
 * — when it was, what kind of meeting, how it was tagged, which folder.
 */
export interface SearchState {
  q: string;
  group: GroupSelection;
  date: DatePreset;
  type: string;
  tag: string;
  /** A project id, or `none` for meetings filed nowhere. */
  project: string;
}

export const EMPTY_SEARCH: SearchState = {
  q: "",
  group: "all",
  date: "any",
  type: "",
  tag: "",
  project: "",
};

/** The project filter value meaning "not filed anywhere". */
export const UNFILED_PROJECT = "none";

/**
 * The groups, in the order they are shown.
 *
 * Meetings first because it is the coarsest answer — which conversations is
 * this about — and mentions second because it is the longest list and the one
 * you scroll. `hint` is what the count means; "27 results" is ambiguous in a
 * way that "27 utterances" is not.
 */
export const GROUPS: { key: ShownGroupKey; label: string; hint: string }[] = [
  { key: "meetings", label: "Meetings", hint: "matched by title, tag or what was said" },
  { key: "mentions", label: "Transcript mentions", hint: "individual utterances" },
];

/** Named on every request, so the API stops answering with what nobody draws. */
const SHOWN_GROUPS: ShownGroupKey[] = GROUPS.map((g) => g.key);

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "Past 7 days" },
  { value: "month", label: "Past 30 days" },
  { value: "quarter", label: "Past 3 months" },
  { value: "year", label: "Past year" },
];

/**
 * A preset as an absolute lower bound.
 *
 * "Today" is midnight local time, not 24 hours ago: a meeting at nine this
 * morning is today's whatever the clock says now, and a rolling day would drop
 * it after nine tonight. The longer presets are rolling on purpose — nobody
 * means "since the 1st" by "past 30 days".
 */
export function presetFrom(preset: DatePreset, now: Date = new Date()): string {
  if (preset === "any") return "";
  const d = new Date(now.getTime());
  if (preset === "today") {
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = { week: 7, month: 30, quarter: 90, year: 365 }[preset];
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** How many filters are on — the number on the "Filters" button. */
export function activeFilterCount(s: SearchState): number {
  return [
    s.date !== "any",
    s.type !== "",
    s.tag !== "",
    s.project !== "",
  ].filter(Boolean).length;
}

export function clearFilters(s: SearchState): SearchState {
  return {
    ...s,
    date: "any",
    type: "",
    tag: "",
    project: "",
  };
}

/**
 * The request this state asks for.
 *
 * `group` decides how many rows: the overview wants a preview of each, and one
 * group opened on its own wants a page of it. The list itself is always sent.
 * An absent one means every group the server has, and four of those are no
 * longer drawn — leaving it off would buy four more searches across four more
 * tables and drop the answers on arrival.
 */
export function toQueryArgs(
  s: SearchState,
  now: Date = new Date(),
): SearchQueryArgs {
  const one = s.group !== "all";
  return {
    q: s.q,
    groups: one ? [s.group as ShownGroupKey] : SHOWN_GROUPS,
    limit: one ? 50 : 5,
    from: presetFrom(s.date, now) || undefined,
    type: s.type || undefined,
    tag: s.tag || undefined,
    project: s.project || undefined,
  };
}

/** Nothing typed and nothing filtered — the page's resting state. */
export function isBlank(s: SearchState): boolean {
  return s.q.trim() === "" && activeFilterCount(s) === 0;
}

/**
 * How many results there are — counting only what the page draws.
 *
 * The server still answers with people, decisions, commitments and risks.
 * Adding those in would put the page into its "there are results" branch and
 * then render nothing: an empty screen insisting it found something.
 */
export function totalResults(res: SearchResponse | undefined): number {
  if (!res) return 0;
  return res.meetings.total + res.mentions.total;
}

/**
 * How similar a passage has to be before it is worth calling a result.
 *
 * <p>Cosine similarity from `text-embedding-3-small`, and the number matters
 * because nearest-neighbour search has no concept of "no match": ask it for ten
 * and it returns ten, however little they have to do with the question. Measured
 * against this workspace, a query of three unrelated nouns tops out at 0.21 and
 * a real paraphrase of something that was said sits at 0.39 and above, so the
 * floor goes between them.
 *
 * <p>It is a property of the embedding model rather than of the archive, so it
 * has to be revisited if the model changes — see `openai_embed_model` in the
 * ai-service config.
 */
export const MEANING_FLOOR = 0.35;

/**
 * The semantic hits actually worth showing under the exact ones.
 *
 * <p>Three things are dropped, and the first two are why an unfiltered list
 * looked broken rather than clever.
 *
 * <p><b>Anything the words already found.</b> The exact search ANDs its terms,
 * so a passage containing all of them is one it matched — and listing it again
 * under "close in meaning" puts the same sentence on the page twice, which reads
 * as the page having lost count rather than as two kinds of answer. What belongs
 * here is only what the word search could not see.
 *
 * <p><b>Anything already on screen.</b> The same utterance can arrive as a
 * transcript mention and as a chunk of the passage around it; matched on the
 * meeting and the second it starts, because those identify a moment while the
 * two texts do not.
 *
 * <p><b>And anything below the floor.</b> See {@link MEANING_FLOOR}.
 */
export function meaningWorthShowing(
  hits: SemanticSearchHit[],
  query: string,
  alreadyShown: SearchMentionHit[] = [],
): SemanticSearchHit[] {
  const words = terms(query).map((t) => t.toLowerCase());
  const seen = new Set(alreadyShown.map((m) => moment(m.meetingId, m.start)));

  return hits.filter((h) => {
    if (h.score < MEANING_FLOOR) return false;
    if (seen.has(moment(h.meetingId, h.start))) return false;
    // Every term, not any: the search itself ANDs them, so one shared common
    // word does not make a passage something the words would have found.
    const text = (h.snippet ?? "").toLowerCase();
    return words.length === 0 || !words.every((w) => text.includes(w));
  });
}

/** A moment in a recording, to the second, for comparing two views of it. */
function moment(meetingId: string, start?: number | null): string {
  return `${meetingId}@${start == null ? "" : Math.floor(start)}`;
}

// ---- URL ------------------------------------------------------------------ //

/**
 * The search as a query string, so it can be bookmarked, reloaded and sent.
 *
 * Only what differs from the default is written. A URL carrying eight empty
 * parameters is unreadable, and worse, it suggests the empty ones are choices
 * somebody made.
 */
export function encodeState(s: SearchState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.group !== "all") p.set("group", s.group);
  if (s.date !== "any") p.set("date", s.date);
  if (s.type) p.set("type", s.type);
  if (s.tag) p.set("tag", s.tag);
  if (s.project) p.set("project", s.project);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

const GROUP_KEYS = new Set<string>(GROUPS.map((g) => g.key));
const DATE_KEYS = new Set<string>(DATE_PRESETS.map((d) => d.value));

/**
 * Reads a URL back into state, ignoring anything it does not recognise.
 *
 * A hand-edited or stale link should open the search it can rather than a blank
 * page or a crash — `?group=widgets` is a group that no longer exists, not an
 * error worth showing anyone.
 */
export function decodeState(search: string): SearchState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const group = p.get("group") ?? "";
  const date = p.get("date") ?? "";
  return {
    ...EMPTY_SEARCH,
    q: p.get("q") ?? "",
    group: GROUP_KEYS.has(group) ? (group as ShownGroupKey) : "all",
    date: DATE_KEYS.has(date) ? (date as DatePreset) : "any",
    type: p.get("type") ?? "",
    tag: p.get("tag") ?? "",
    project: p.get("project") ?? "",
  };
}

// ---- Text ----------------------------------------------------------------- //

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Terms, split the way the server splits them: on anything not alphanumeric.
 *
 * Used by the highlighter and by {@link meaningWorthShowing}, which both have to
 * agree with the server about what counts as a word — a highlighter that marks
 * something the search did not match on is a claim about why a result is there.
 */
function terms(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Splits text into matched and unmatched runs, for rendering.
 *
 * Every term is escaped before it reaches the regular expression. Without that,
 * searching for "(draft)" or "c++" throws inside a render — a crash caused by
 * ordinary punctuation in a search box, on the one screen whose entire job is
 * accepting arbitrary text.
 */
export function highlight(text: string, query: string): TextPart[] {
  const found = terms(query);
  if (found.length === 0 || !text) return [{ text, match: false }];

  const pattern = new RegExp(
    `(${found.map((t) => t.replace(ESCAPE, "\\$&")).join("|")})`,
    "giu",
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({
      text: part,
      match: found.some((t) => t.toLowerCase() === part.toLowerCase()),
    }));
}

/**
 * Trims long text to a window around the first match.
 *
 * A transcript utterance can run for a paragraph, and the term is as likely to
 * be at the end of it as the start. Cutting from the beginning would show the
 * user a sentence with no visible reason for being in their results.
 */
export function snippet(text: string, query: string, radius = 90): string {
  const clean = (text ?? "").trim();
  if (clean.length <= radius * 2) return clean;

  const found = terms(query);
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of found) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return `${clean.slice(0, radius * 2).trimEnd()}…`;

  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + radius);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${
    end < clean.length ? "…" : ""
  }`;
}

/**
 * Where a result links to.
 *
 * A mention carries a timestamp, and dropping it would land the reader at the
 * top of an hour-long transcript holding the sentence they were promised.
 */
export function meetingHref(meetingId: string, start?: number | null): string {
  return start != null && start > 0
    ? `/meetings/${meetingId}?t=${Math.floor(start)}`
    : `/meetings/${meetingId}`;
}
