import { describe, it, expect } from "vitest";
import {
  EMPTY_SEARCH,
  highlight,
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

});

describe("request arguments", () => {
  it("asks for both groups, and for enough of each to be the whole answer", () => {
    const args = toQueryArgs(state({ q: "stripe" }), NOW);

    // Named rather than omitted. Absent means every group the server has, and
    // four of those are no longer rendered — asking for them buys four more
    // searches whose answers are dropped on arrival.
    expect(args.groups).toEqual(["meetings", "mentions"]);
    // Five was a preview, with "See all results" opening a page that fetched
    // fifty. There is no page: this list is what the search found.
    expect(args.limit).toBe(25);
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

});
