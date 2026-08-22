import type {
  SearchGroupKey,
  SearchMentionHit,
  SearchQueryArgs,
  SearchResponse,
} from "@/lib/types";

/**
 * The state behind the search box, and the arithmetic that turns it into a
 * request and into highlighted text.
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
 * The groups asked for, in the order they are drawn.
 *
 * Named on every request, so the API stops answering with what nobody renders.
 * Meetings first because it is the coarsest answer — which conversations is
 * this about — and mentions second because it is the longest list and the one
 * you scroll.
 *
 * This used to be a table with a label and a hint per group, for the tabs on
 * the results page. The page is gone and the box does not tab.
 */
const SHOWN_GROUPS: ShownGroupKey[] = ["meetings", "mentions"];

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
    // Both groups used to fetch five rows each, because the overlay was a
    // preview and "See all results" opened a page that fetched fifty. The page
    // is gone and this is the whole answer now, so it asks for a list worth
    // scrolling — which is what the results panel already does.
    limit: one ? 50 : 25,
    from: presetFrom(s.date, now) || undefined,
    type: s.type || undefined,
    tag: s.tag || undefined,
    project: s.project || undefined,
  };
}

/**
 * How many results there are — counting only what the box draws.
 *
 * The server still answers with people, decisions, commitments and risks.
 * Adding those in would put the box into its "there are results" branch and
 * then render nothing: an empty panel insisting it found something.
 */
export function totalResults(res: SearchResponse | undefined): number {
  if (!res) return 0;
  return res.meetings.total + res.mentions.total;
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
