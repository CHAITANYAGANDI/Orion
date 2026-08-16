/**
 * One box instead of eight dropdowns.
 *
 * The search page used to put its filters beside the input as a row of
 * selects — date, speaker, type, tag, project, status, owner. That works when
 * you already know which control holds the thing you want, and it is the wrong
 * shape for the way people actually search an archive: you type "priya stripe"
 * and mean "the bits where Priya talked about Stripe", without having decided in
 * advance that "priya" is a speaker filter and "stripe" is a term.
 *
 * So the filters move into the text. `from:priya stripe` is the same search the
 * dropdowns expressed, written the way it is thought, and the box can suggest
 * the rest of `from:pri…` from the speakers that actually exist. The state
 * behind it is unchanged — see `lib/search.ts` — which is what keeps the URL,
 * the API call and the results page exactly as they were.
 *
 * Everything here is pure. The grammar is small and every part of it is easy to
 * get subtly wrong in a way that renders perfectly: a quote that swallows the
 * rest of the line, a value that matches a project by prefix and silently
 * chooses the wrong one, a token that survives being deleted from the text.
 */

import { EMPTY_SEARCH, UNFILED_PROJECT, type DatePreset, type SearchState } from "@/lib/search";
import type { Project, SearchFacets } from "@/lib/types";

/** Which part of a search a prefix sets. */
export type FilterField =
  | "speaker"
  | "owner"
  | "tag"
  | "type"
  | "status"
  | "project"
  | "date"
  | "decisions";

export interface FilterSpec {
  field: FilterField;
  /** Every spelling accepted. The first is the one the box writes back. */
  keys: string[];
  /** What the chip says before the value. */
  label: string;
  /** One line in the suggestion list, describing what it narrows. */
  hint: string;
}

/**
 * The vocabulary.
 *
 * Two spellings for most fields, and the aliases are not decoration: `from:` is
 * what anyone who has used an email client will type for a person, and `in:` is
 * what they will type for a place. Accepting only the internal name would mean
 * the box quietly treating `from:priya` as free text and returning nothing.
 */
export const FILTERS: FilterSpec[] = [
  { field: "speaker", keys: ["from", "speaker"], label: "from", hint: "who was speaking" },
  { field: "owner", keys: ["owner", "assigned"], label: "owner", hint: "whose action item" },
  { field: "project", keys: ["in", "folder", "project"], label: "in", hint: "which folder" },
  { field: "tag", keys: ["tag"], label: "tag", hint: "a tag on the meeting" },
  { field: "type", keys: ["type"], label: "type", hint: "the kind of meeting" },
  { field: "status", keys: ["status"], label: "status", hint: "how far processing got" },
  { field: "date", keys: ["when", "date"], label: "when", hint: "a time frame" },
  { field: "decisions", keys: ["decided"], label: "decided", hint: "only meetings that settled something" },
];

/** The time frames `when:` accepts, in the order the suggestions offer them. */
export const DATE_VALUES: { value: DatePreset; label: string }[] = [
  { value: "today", label: "today" },
  { value: "week", label: "this week" },
  { value: "month", label: "this month" },
  { value: "quarter", label: "this quarter" },
  { value: "year", label: "this year" },
];

export interface FilterToken {
  field: FilterField;
  /** The key as typed, so rewriting the text does not rename what somebody wrote. */
  key: string;
  /** The value as typed. Resolution to an id happens later and separately. */
  value: string;
  /** Where it sat in the input, so one token can be replaced without a re-parse. */
  start: number;
  end: number;
}

export interface ParsedQuery {
  /** Everything that was not a filter, joined back into a search term. */
  text: string;
  tokens: FilterToken[];
}

const KEY_TO_FIELD: Record<string, FilterField> = Object.fromEntries(
  FILTERS.flatMap((f) => f.keys.map((k) => [k, f.field])),
) as Record<string, FilterField>;

/**
 * Split the input into filters and free text.
 *
 * A value may be quoted — `in:"Q4 planning"` — because folder and speaker names
 * have spaces in them and the unquoted form would take only the first word and
 * search for the rest. An unterminated quote is treated as running to the end of
 * the input rather than as an error: it is what somebody halfway through typing
 * one has, and refusing to parse it would make the suggestions vanish at exactly
 * the moment they are needed.
 */
export function parseQuery(input: string): ParsedQuery {
  const tokens: FilterToken[] = [];
  const terms: string[] = [];

  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }
    const start = i;
    // Read a word, keeping quoted runs whole.
    let word = "";
    let quoted = false;
    while (i < input.length && (quoted || !/\s/.test(input[i]))) {
      if (input[i] === '"') {
        quoted = !quoted;
        i += 1;
        continue;
      }
      word += input[i];
      i += 1;
    }

    const colon = word.indexOf(":");
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
    const field = KEY_TO_FIELD[key];
    if (field && colon > 0) {
      tokens.push({ field, key, value: word.slice(colon + 1), start, end: i });
    } else if (word) {
      terms.push(word);
    }
  }

  return { text: terms.join(" "), tokens };
}

/**
 * Turn parsed tokens into the state the results page already understands.
 *
 * Values are matched against what the workspace actually has, case-insensitively
 * and — for projects, whose names are long — by exact name first and prefix
 * second. A value that matches nothing is dropped rather than passed through:
 * sending `speaker=Pryia` to the API returns an empty page that looks like a
 * broken search, whereas dropping it returns the results for everything else and
 * lets the misspelling be obvious.
 */
export function toSearchState(
  parsed: ParsedQuery,
  catalog: { facets?: SearchFacets; projects?: Project[] } = {},
  base: SearchState = EMPTY_SEARCH,
): SearchState {
  const state: SearchState = { ...base, ...EMPTY_SEARCH, q: parsed.text, mode: base.mode, group: base.group };

  for (const token of parsed.tokens) {
    const value = token.value.trim();
    if (!value) continue;

    switch (token.field) {
      case "speaker":
        state.speaker = matchOne(value, catalog.facets?.speakers) ?? state.speaker;
        break;
      case "owner":
        state.owner = matchOne(value, catalog.facets?.owners) ?? state.owner;
        break;
      case "tag":
        state.tag = matchOne(value, catalog.facets?.tags) ?? state.tag;
        break;
      case "type":
        state.type = matchOne(value, catalog.facets?.types) ?? state.type;
        break;
      case "status":
        state.status = matchOne(value, catalog.facets?.statuses) ?? state.status;
        break;
      case "project":
        state.project = matchProject(value, catalog.projects) ?? state.project;
        break;
      case "date": {
        const preset = DATE_VALUES.find(
          (d) => d.value === value.toLowerCase() || d.label === value.toLowerCase(),
        );
        if (preset) state.date = preset.value;
        break;
      }
      case "decisions":
        // Present at all means yes. `decided:no` is a search nobody performs,
        // and treating it as "meetings that decided nothing" would be a filter
        // the API has no way to answer.
        state.withDecisions = !/^(no|false|0)$/i.test(value);
        break;
    }
  }
  return state;
}

/**
 * Write a state back out as text.
 *
 * Used when the box is opened on a search that came from a URL, so what is in
 * the input is the same search the page is showing rather than an empty box over
 * filtered results. Values are quoted only when they need it — quoting
 * everything makes a readable query look like a config file.
 */
export function formatQuery(
  state: SearchState,
  catalog: { projects?: Project[] } = {},
): string {
  const parts: string[] = [];
  if (state.q.trim()) parts.push(state.q.trim());
  if (state.speaker) parts.push(`from:${quote(state.speaker)}`);
  if (state.owner) parts.push(`owner:${quote(state.owner)}`);
  if (state.project) {
    const name =
      state.project === UNFILED_PROJECT
        ? "unfiled"
        : catalog.projects?.find((p) => p.id === state.project)?.name;
    if (name) parts.push(`in:${quote(name)}`);
  }
  if (state.tag) parts.push(`tag:${quote(state.tag)}`);
  if (state.type) parts.push(`type:${quote(state.type)}`);
  if (state.status) parts.push(`status:${quote(state.status)}`);
  if (state.date !== "any") parts.push(`when:${state.date}`);
  if (state.withDecisions) parts.push("decided:yes");
  return parts.join(" ");
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Resolve a typed value against what the workspace actually has.
 *
 * Exact match first, prefix second, and only when the prefix is unambiguous. A
 * prefix that matches two speakers is not a search anybody meant — silently
 * picking the first would answer a question about Priya with Priyanka's lines,
 * and there is nothing on screen that would reveal it.
 */
function matchOne(typed: string, options?: string[]): string | null {
  if (!options || options.length === 0) return null;
  const needle = typed.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed = options.filter((o) => o.toLowerCase().startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** The same, but a project resolves to its id — and "unfiled" is a real answer. */
function matchProject(typed: string, projects?: Project[]): string | null {
  if (/^unfiled$/i.test(typed.trim())) return UNFILED_PROJECT;
  const name = matchOne(typed, (projects ?? []).map((p) => p.name));
  return name ? (projects ?? []).find((p) => p.name === name)?.id ?? null : null;
}

/* ------------------------------- suggestions ------------------------------ */

export interface Suggestion {
  /** What replaces the partial token when this is chosen. */
  insert: string;
  label: string;
  hint: string;
  kind: "filter" | "value";
}

/**
 * What to offer for the word being typed.
 *
 * Two states, and they are genuinely different questions. Before a colon the
 * answer is "which filters exist"; after one it is "which values does this
 * workspace have for that filter" — and the second is the one that makes the
 * box usable, because it is the difference between remembering how a colleague
 * spells their name and picking it off a list.
 *
 * Returns nothing for a bare word. A search box that suggests completions for
 * ordinary terms is guessing at what somebody meant to type, and gets in the way
 * of the far commoner case of typing exactly what they meant.
 */
export function suggestFor(
  word: string,
  catalog: { facets?: SearchFacets; projects?: Project[] } = {},
  limit = 8,
): Suggestion[] {
  const colon = word.indexOf(":");

  if (colon < 0) {
    const partial = word.toLowerCase();
    if (!partial) return [];
    return FILTERS.filter((f) => f.keys.some((k) => k.startsWith(partial)))
      .map((f) => ({
        insert: `${f.keys[0]}:`,
        label: `${f.keys[0]}:`,
        hint: f.hint,
        kind: "filter" as const,
      }))
      .slice(0, limit);
  }

  const key = word.slice(0, colon).toLowerCase();
  const field = KEY_TO_FIELD[key];
  if (!field) return [];
  const partial = word.slice(colon + 1).replace(/"/g, "").toLowerCase();

  const values = valuesFor(field, catalog);
  return values
    .filter((v) => v.label.toLowerCase().includes(partial))
    .slice(0, limit)
    .map((v) => ({
      insert: `${key}:${quote(v.label)}`,
      label: v.label,
      hint: v.hint,
      kind: "value" as const,
    }));
}

function valuesFor(
  field: FilterField,
  catalog: { facets?: SearchFacets; projects?: Project[] },
): { label: string; hint: string }[] {
  switch (field) {
    case "speaker":
      return (catalog.facets?.speakers ?? []).map((s) => ({ label: s, hint: "speaker" }));
    case "owner":
      return (catalog.facets?.owners ?? []).map((o) => ({ label: o, hint: "action owner" }));
    case "tag":
      return (catalog.facets?.tags ?? []).map((t) => ({ label: t, hint: "tag" }));
    case "type":
      return (catalog.facets?.types ?? []).map((t) => ({ label: t, hint: "meeting type" }));
    case "status":
      return (catalog.facets?.statuses ?? []).map((s) => ({ label: s, hint: "status" }));
    case "project":
      return [
        ...(catalog.projects ?? []).map((p) => ({ label: p.name, hint: "folder" })),
        { label: "unfiled", hint: "not in a folder" },
      ];
    case "date":
      return DATE_VALUES.map((d) => ({ label: d.value, hint: d.label }));
    case "decisions":
      return [{ label: "yes", hint: "only meetings that settled something" }];
  }
}

/**
 * The word the cursor is inside, and where it starts.
 *
 * Quotes are counted rather than matched: inside `in:"Q4 pla|` the cursor is
 * still in one word, and a naive split on whitespace would offer completions for
 * "pla" against nothing.
 */
export function wordAt(input: string, cursor: number): { word: string; start: number } {
  let start = 0;
  let quotes = 0;
  for (let i = 0; i < cursor; i += 1) {
    if (input[i] === '"') quotes += 1;
    if (/\s/.test(input[i]) && quotes % 2 === 0) start = i + 1;
  }
  let end = cursor;
  let openAfter = quotes % 2 === 1;
  while (end < input.length && (openAfter || !/\s/.test(input[end]))) {
    if (input[end] === '"') openAfter = !openAfter;
    end += 1;
  }
  return { word: input.slice(start, end), start };
}

/** Replace the word at the cursor with a chosen suggestion, and leave a space. */
export function applySuggestion(
  input: string,
  cursor: number,
  suggestion: Suggestion,
): { text: string; cursor: number } {
  const { word, start } = wordAt(input, cursor);
  const before = input.slice(0, start);
  const after = input.slice(start + word.length);
  // A filter key is only half a token, so the cursor stays put for the value;
  // a value completes the token, so it gets a space and moves on.
  const trailing = suggestion.kind === "filter" ? "" : " ";
  const text = `${before}${suggestion.insert}${trailing}${after}`;
  return { text, cursor: before.length + suggestion.insert.length + trailing.length };
}

/** Human-readable chips for what a query narrows to, shown under the box. */
export function describeTokens(parsed: ParsedQuery): { label: string; value: string }[] {
  return parsed.tokens
    .filter((t) => t.value.trim())
    .map((t) => ({
      label: FILTERS.find((f) => f.field === t.field)?.label ?? t.key,
      value: t.value,
    }));
}
