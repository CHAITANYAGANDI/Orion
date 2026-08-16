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
  meetingHref,
  presetFrom,
  snippet,
  toQueryArgs,
  totalResults,
  type SearchState,
} from "@/lib/search";
import type { SearchResponse } from "@/lib/types";

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
      activeFilterCount(state({ date: "week", speaker: "Priya", withDecisions: true })),
    ).toBe(3);
  });

  it("treats a filter with no search term as a real search", () => {
    // "Everything from last week where Priya spoke" is a question.
    expect(isBlank(state({ speaker: "Priya" }))).toBe(false);
  });

  it("clears the filters and leaves the search alone", () => {
    const cleared = clearFilters(state({ q: "stripe", group: "mentions", speaker: "Priya" }));

    expect(activeFilterCount(cleared)).toBe(0);
    expect(cleared.q).toBe("stripe");
    expect(cleared.group).toBe("mentions");
  });
});

describe("request arguments", () => {
  it("asks for a preview of everything on the overview", () => {
    const args = toQueryArgs(state({ q: "stripe" }), NOW);

    // No group list: the server reads absent as all of them.
    expect(args.groups).toBeUndefined();
    expect(args.limit).toBe(5);
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
    expect(args.speaker).toBeUndefined();
    expect(args.withDecisions).toBeUndefined();
  });

  it("passes the filters that are set", () => {
    const args = toQueryArgs(
      state({ q: "stripe", date: "week", speaker: "Priya", withDecisions: true }),
      NOW,
    );

    expect(args.speaker).toBe("Priya");
    expect(args.withDecisions).toBe(true);
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
      mode: "meaning",
      group: "mentions",
      date: "quarter",
      status: "READY",
      type: "one-on-one",
      tag: "finance",
      speaker: "Priya",
      owner: "Marcus",
      withDecisions: true,
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

  it("adds up every group", () => {
    expect(totalResults(response)).toBe(49);
  });

  it("is zero before anything has loaded", () => {
    expect(totalResults(undefined)).toBe(0);
  });

  it("has a label and a hint for every group", () => {
    // The counts are the interface; "27 results" is ambiguous where "27
    // utterances" is not.
    expect(GROUPS).toHaveLength(6);
    for (const g of GROUPS) {
      expect(g.label).not.toBe("");
      expect(g.hint).not.toBe("");
    }
  });
});
