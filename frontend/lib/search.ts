import type {
  SearchGroupKey,
  SearchQueryArgs,
  SearchResponse,
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

export type SearchMode = "everything" | "meaning";

/** `all` is the overview: every group at once, a few rows each. */
export type GroupSelection = SearchGroupKey | "all";

export type DatePreset =
  | "any"
  | "today"
  | "week"
  | "month"
  | "quarter"
  | "year";

export interface SearchState {
  q: string;
  mode: SearchMode;
  group: GroupSelection;
  date: DatePreset;
  status: string;
  type: string;
  tag: string;
  /** A project id, or `none` for meetings filed nowhere. */
  project: string;
  speaker: string;
  owner: string;
  withDecisions: boolean;
}

export const EMPTY_SEARCH: SearchState = {
  q: "",
  mode: "everything",
  group: "all",
  date: "any",
  status: "",
  type: "",
  tag: "",
  project: "",
  speaker: "",
  owner: "",
  withDecisions: false,
};

/** The project filter value meaning "not filed anywhere". */
export const UNFILED_PROJECT = "none";

/**
 * The groups, in the order they are shown.
 *
 * Meetings first because it is the coarsest answer — which conversations is
 * this about — and mentions last because it is the longest list and the one you
 * scroll. `hint` is what the count means; "27 results" is ambiguous in a way
 * that "27 utterances" is not.
 */
export const GROUPS: { key: SearchGroupKey; label: string; hint: string }[] = [
  { key: "meetings", label: "Meetings", hint: "matched by title, tag or what was said" },
  { key: "people", label: "People", hint: "speakers in your transcripts" },
  { key: "decisions", label: "Decisions", hint: "what meetings settled" },
  { key: "commitments", label: "Commitments", hint: "action items and their owners" },
  { key: "risks", label: "Risks", hint: "risks and blockers raised" },
  { key: "mentions", label: "Transcript mentions", hint: "individual utterances" },
];

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
    s.status !== "",
    s.type !== "",
    s.tag !== "",
    s.project !== "",
    s.speaker !== "",
    s.owner !== "",
    s.withDecisions,
  ].filter(Boolean).length;
}

export function clearFilters(s: SearchState): SearchState {
  return {
    ...s,
    date: "any",
    status: "",
    type: "",
    tag: "",
    project: "",
    speaker: "",
    owner: "",
    withDecisions: false,
  };
}

/**
 * The request this state asks for.
 *
 * `group` decides both which groups are fetched and how many rows: the overview
 * wants a preview of each, and one group opened on its own wants a page of it.
 * Sending `groups` for the overview would be redundant — the server reads an
 * absent list as all of them — so it is omitted and the URL stays short.
 */
export function toQueryArgs(
  s: SearchState,
  now: Date = new Date(),
): SearchQueryArgs {
  const one = s.group !== "all";
  return {
    q: s.q,
    ...(one ? { groups: [s.group as SearchGroupKey], limit: 50 } : { limit: 5 }),
    from: presetFrom(s.date, now) || undefined,
    status: (s.status || undefined) as SearchQueryArgs["status"],
    type: s.type || undefined,
    tag: s.tag || undefined,
    project: s.project || undefined,
    speaker: s.speaker || undefined,
    owner: s.owner || undefined,
    withDecisions: s.withDecisions || undefined,
  };
}

/** Nothing typed and nothing filtered — the page's resting state. */
export function isBlank(s: SearchState): boolean {
  return s.q.trim() === "" && activeFilterCount(s) === 0;
}

export function totalResults(res: SearchResponse | undefined): number {
  if (!res) return 0;
  return (
    res.meetings.total +
    res.people.total +
    res.decisions.total +
    res.risks.total +
    res.commitments.total +
    res.mentions.total
  );
}

export function groupTotal(
  res: SearchResponse | undefined,
  key: SearchGroupKey,
): number {
  return res ? res[key].total : 0;
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
  if (s.mode !== "everything") p.set("mode", s.mode);
  if (s.group !== "all") p.set("group", s.group);
  if (s.date !== "any") p.set("date", s.date);
  if (s.status) p.set("status", s.status);
  if (s.type) p.set("type", s.type);
  if (s.tag) p.set("tag", s.tag);
  if (s.project) p.set("project", s.project);
  if (s.speaker) p.set("speaker", s.speaker);
  if (s.owner) p.set("owner", s.owner);
  if (s.withDecisions) p.set("withDecisions", "true");
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
    mode: p.get("mode") === "meaning" ? "meaning" : "everything",
    group: GROUP_KEYS.has(group) ? (group as SearchGroupKey) : "all",
    date: DATE_KEYS.has(date) ? (date as DatePreset) : "any",
    status: p.get("status") ?? "",
    type: p.get("type") ?? "",
    tag: p.get("tag") ?? "",
    project: p.get("project") ?? "",
    speaker: p.get("speaker") ?? "",
    owner: p.get("owner") ?? "",
    withDecisions: p.get("withDecisions") === "true",
  };
}

// ---- Text ----------------------------------------------------------------- //

export interface TextPart {
  text: string;
  match: boolean;
}

/** Terms, split the way the server splits them: on anything not alphanumeric. */
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
