import { describe, it, expect } from "vitest";
import {
  DATE_PRESETS,
  EMPTY_SEARCH,
  GROUPS,
  activeFilterCount,
  clearFilters,
  decodeState,
  encodeState,
  highlight,
  isBlank,
  MEANING_FLOOR,
  meaningWorthShowing,
  meetingHref,
  presetFrom,
  snippet,
  toQueryArgs,
  totalResults,
  type SearchState,
} from "@/lib/search";
import type { SearchMentionHit, SearchResponse, SemanticSearchHit } from "@/lib/types";

/**
 * The rules behind the search page.
 *
 * Every one of these renders perfectly when wrong, which is why they are tested
 * here rather than through the page: a date bound off by a day, a filter lost
 * on reload, a highlighter that throws on a bracket. None of it needs a DOM,
 * and all of it is the kind of thing that gets quietly broken by an unrelated
 * change six weeks from now.
 */

const NOW = new Date("2026-08-15T14:30:00.000Z");

function state(over: Partial<SearchState> = {}): SearchState {
  return { ...EMPTY_SEARCH, ...over };
}

describe("date presets", () => {
  it("starts today at midnight, not 24 hours ago", () => {
    // A meeting at nine this morning is still today's at nine tonight. A
    // rolling day would drop it off the list halfway through the evening.
    const from = new Date(presetFrom("today", NOW));

    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getDate()).toBe(NOW.getDate());
  });

  it("rolls the longer windows back from now", () => {
    // Nobody means "since the 1st" by "past 30 days".
    const week = new Date(presetFrom("week", NOW));
    expect(Math.round((NOW.getTime() - week.getTime()) / 86_400_000)).toBe(7);

    const year = new Date(presetFrom("year", NOW));
    expect(Math.round((NOW.getTime() - year.getTime()) / 86_400_000)).toBe(365);
  });

  it("has no bound at all for any time", () => {
    expect(presetFrom("any", NOW)).toBe("");
  });

  it("offers a preset for every value the state can hold", () => {
    for (const preset of DATE_PRESETS) {
      expect(() => presetFrom(preset.value, NOW)).not.toThrow();
    }
  });
});

describe("filter counting", () => {
  it("counts nothing when nothing is set", () => {
    expect(activeFilterCount(EMPTY_SEARCH)).toBe(0);
    expect(isBlank(EMPTY_SEARCH)).toBe(true);
  });

  it("does not count the search term as a filter", () => {
    expect(activeFilterCount(state({ q: "stripe" }))).toBe(0);
    expect(isBlank(state({ q: "stripe" }))).toBe(false);
  });

  it("counts each filter once", () => {
    expect(
      activeFilterCount(state({ date: "week", tag: "finance", project: "prj_1" })),
    ).toBe(3);
  });

  it("counts only what the bar can show and clear", () => {
    // Four filters, four dropdowns. A fifth in the state would be a search
    // narrowed by something with nothing on screen saying so, and no way off.
    expect(activeFilterCount(state({ date: "week", type: "standup", tag: "q4", project: "p" })))
      .toBe(4);
  });

  it("treats a filter with no search term as a real search", () => {
    // "Everything tagged finance, last week" is a question.
    expect(isBlank(state({ tag: "finance" }))).toBe(false);
  });

  it("clears the filters and leaves the search alone", () => {
    const cleared = clearFilters(state({ q: "stripe", group: "mentions", tag: "finance" }));

    expect(activeFilterCount(cleared)).toBe(0);
    expect(cleared.q).toBe("stripe");
    expect(cleared.group).toBe("mentions");
  });
});

describe("request arguments", () => {
  it("asks for a preview of both groups on the overview", () => {
    const args = toQueryArgs(state({ q: "stripe" }), NOW);

    // Named rather than omitted. Absent means every group the server has, and
    // four of those are no longer rendered — asking for them buys four more
    // searches whose answers are dropped on arrival.
    expect(args.groups).toEqual(["meetings", "mentions"]);
    expect(args.limit).toBe(5);
  });

  it("never asks for a group the page cannot draw", () => {
    for (const s of [state({ q: "x" }), state({ q: "x", group: "meetings" })]) {
      for (const g of toQueryArgs(s, NOW).groups ?? []) {
        expect(["meetings", "mentions"]).toContain(g);
      }
    }
  });

  it("asks for one deep group when one is opened", () => {
    const args = toQueryArgs(state({ q: "stripe", group: "mentions" }), NOW);

    expect(args.groups).toEqual(["mentions"]);
    expect(args.limit).toBe(50);
  });

  it("omits every filter that is not set", () => {
    const args = toQueryArgs(state({ q: "stripe" }), NOW);

    // Sent empty, these would be part of the cache key, and `?q=stripe` and
    // `?q=stripe&tag=` would be fetched as two different searches.
    expect(args.from).toBeUndefined();
    expect(args.tag).toBeUndefined();
    expect(args.type).toBeUndefined();
    expect(args.project).toBeUndefined();
  });

  it("passes the filters that are set", () => {
    const args = toQueryArgs(
      state({ q: "stripe", date: "week", tag: "finance", project: "prj_1" }),
      NOW,
    );

    expect(args.tag).toBe("finance");
    expect(args.project).toBe("prj_1");
    expect(args.from).toBe(presetFrom("week", NOW));
  });
});

describe("the URL", () => {
  it("writes only what differs from the default", () => {
    // Eight empty parameters are unreadable, and imply choices nobody made.
    expect(encodeState(state({ q: "stripe" }))).toBe("?q=stripe");
    expect(encodeState(EMPTY_SEARCH)).toBe("");
  });

  it("survives a round trip with everything set", () => {
    const full = state({
      q: "stripe migration",
      group: "mentions",
      date: "quarter",
      type: "one-on-one",
      tag: "finance",
      project: "prj_1",
    });

    expect(decodeState(encodeState(full))).toEqual(full);
  });

  it("ignores values it does not recognise", () => {
    // A stale or hand-edited link should open the search it can.
    const decoded = decodeState("?q=stripe&group=widgets&date=fortnight");

    expect(decoded.q).toBe("stripe");
    expect(decoded.group).toBe("all");
    expect(decoded.date).toBe("any");
  });

  it("reads an empty URL as the resting state", () => {
    expect(decodeState("")).toEqual(EMPTY_SEARCH);
    expect(decodeState("?")).toEqual(EMPTY_SEARCH);
  });
});

describe("highlighting", () => {
  it("marks the term inside the text", () => {
    expect(highlight("The Stripe migration", "stripe")).toEqual([
      { text: "The ", match: false },
      { text: "Stripe", match: true },
      { text: " migration", match: false },
    ]);
  });

  it("marks every term of a multi-word search", () => {
    const parts = highlight("stripe and acme", "acme stripe");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["stripe", "acme"]);
  });

  it("does not treat the search term as a regular expression", () => {
    // Ordinary punctuation in a search box would otherwise throw inside a
    // render, on the one screen whose whole job is arbitrary text.
    expect(() => highlight("the (draft) plan", "(draft)")).not.toThrow();
    expect(highlight("c++ rewrite", "c++").some((p) => p.match)).toBe(true);
  });

  it("leaves text alone when nothing was searched for", () => {
    expect(highlight("anything", "")).toEqual([{ text: "anything", match: false }]);
    expect(highlight("anything", "???")).toEqual([{ text: "anything", match: false }]);
  });
});

describe("snippets", () => {
  const long = `${"a ".repeat(120)}stripe invoice ${"b ".repeat(120)}`;

  it("leaves short text whole", () => {
    expect(snippet("short enough", "stripe")).toBe("short enough");
  });

  it("cuts a window around the match, not from the start", () => {
    const cut = snippet(long, "stripe");

    // Cutting from the beginning shows a sentence with no visible reason for
    // being in the results.
    expect(cut).toContain("stripe");
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
  });

  it("falls back to the opening when the term is not in the text", () => {
    // Commitments match on their owner and source sentence too, so a hit whose
    // visible text has no match in it is normal rather than a bug.
    const cut = snippet(long, "nowhere");

    expect(cut.startsWith("a a")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("links", () => {
  it("seeks to the mention", () => {
    expect(meetingHref("mtg_1", 942.7)).toBe("/meetings/mtg_1?t=942");
  });

  it("opens at the top when there is no timestamp", () => {
    expect(meetingHref("mtg_1", null)).toBe("/meetings/mtg_1");
    expect(meetingHref("mtg_1", 0)).toBe("/meetings/mtg_1");
  });
});

describe("totals", () => {
  const response = {
    query: "stripe",
    meetings: { total: 12, hits: [] },
    people: { total: 1, hits: [] },
    decisions: { total: 3, hits: [] },
    risks: { total: 2, hits: [] },
    commitments: { total: 4, hits: [] },
    mentions: { total: 27, hits: [] },
  } as unknown as SearchResponse;

  it("adds up only the groups the page draws", () => {
    // The server still answers with people, decisions, commitments and risks.
    // Counting them would put the page in its "there are results" branch and
    // then render nothing: an empty screen insisting it found something.
    expect(totalResults(response)).toBe(39);
  });

  it("is zero when the only matches are in groups that are not shown", () => {
    const hidden = {
      ...response,
      meetings: { total: 0, hits: [] },
      mentions: { total: 0, hits: [] },
    } as unknown as SearchResponse;

    expect(totalResults(hidden)).toBe(0);
  });

  it("is zero before anything has loaded", () => {
    expect(totalResults(undefined)).toBe(0);
  });

  it("has a label and a hint for every group", () => {
    // The counts are the interface; "27 results" is ambiguous where "27
    // utterances" is not.
    expect(GROUPS.map((g) => g.key)).toEqual(["meetings", "mentions"]);
    for (const g of GROUPS) {
      expect(g.label).not.toBe("");
      expect(g.hint).not.toBe("");
    }
  });
});

/**
 * Which semantic hits are worth calling results.
 *
 * <p>The failure this prevents is specific and was on screen: nearest-neighbour
 * search has no idea of "no match". Ask it for ten and it returns ten, so a
 * search for "hello" listed the two sentences the word search had already shown
 * — at the top, because a passage containing a word is the nearest thing to it —
 * followed by whatever else the index had. The same sentence twice on one page
 * reads as the page having lost count; three unrelated passages under a heading
 * saying they are about your question reads as it having stopped understanding
 * one.
 */
function hit(over: Partial<SemanticSearchHit> = {}): SemanticSearchHit {
  return {
    meetingId: "mtg_1",
    meetingTitle: "Finance review",
    meetingStatus: "READY",
    meetingCreatedAt: "2026-08-01T10:00:00Z",
    chunkIndex: 0,
    snippet: "They pushed back hard on the numbers for next quarter.",
    start: 120,
    score: 0.8,
    ...over,
  };
}

function mention(over: Partial<SearchMentionHit> = {}): SearchMentionHit {
  return {
    segmentId: "seg_1",
    meetingId: "mtg_1",
    meetingTitle: "Finance review",
    meetingCreatedAt: "2026-08-01T10:00:00Z",
    speaker: "Priya",
    start: 120,
    text: "They pushed back hard on the numbers.",
    ...over,
  } as SearchMentionHit;
}

describe("what counts as close in meaning", () => {
  it("keeps a passage that says the thing without using the words", () => {
    const kept = meaningWorthShowing([hit()], "budget pushback");

    // The whole reason the section exists.
    expect(kept).toHaveLength(1);
  });

  it("drops a passage the words already found", () => {
    // The exact search ANDs its terms, so a passage containing all of them is
    // one it matched — and it is already on the page above.
    const kept = meaningWorthShowing([hit({ snippet: "Hello. Hi. How are you?" })], "hello");

    expect(kept).toEqual([]);
  });

  it("does not treat one shared common word as an exact match", () => {
    // "the" is a term. Dropping everything containing it would empty the
    // section for every multi-word search.
    const kept = meaningWorthShowing([hit()], "the budget pushback");

    expect(kept).toHaveLength(1);
  });

  it("drops a moment already listed as a transcript mention", () => {
    // The same utterance arrives twice: once as the segment that matched, once
    // as the chunk of the passage around it.
    const kept = meaningWorthShowing([hit({ snippet: "Something else entirely." })], "budget", [
      mention({ meetingId: "mtg_1", start: 120.4 }),
    ]);

    expect(kept).toEqual([]);
  });

  it("keeps a different moment in the same meeting", () => {
    const kept = meaningWorthShowing(
      [hit({ snippet: "Something else entirely.", start: 900 })],
      "budget",
      [mention({ meetingId: "mtg_1", start: 120 })],
    );

    expect(kept).toHaveLength(1);
  });

  it("drops everything for a query nothing in the archive is about", () => {
    // Measured: three unrelated nouns come back with six hits, the best of them
    // at 0.21. Without a floor the page answers a question nobody can answer.
    const noise = [0.21, 0.18, 0.14, 0.11].map((score) =>
      hit({ score, snippet: "Unrelated chatter." }),
    );

    expect(meaningWorthShowing(noise, "zebra quantum banana")).toEqual([]);
  });

  it("puts the floor between noise and a real match", () => {
    // Sitting the boundary on measured numbers rather than a feeling: nonsense
    // peaks at 0.21 here and a real paraphrase scores 0.39 and up.
    expect(MEANING_FLOOR).toBeGreaterThan(0.21);
    expect(MEANING_FLOOR).toBeLessThan(0.39);
  });

  it("has nothing to filter before anything has come back", () => {
    expect(meaningWorthShowing([], "budget")).toEqual([]);
  });
});
