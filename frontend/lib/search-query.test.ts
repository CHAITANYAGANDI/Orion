import { describe, it, expect } from "vitest";
import {
  parseQuery,
  toSearchState,
  formatQuery,
  suggestFor,
  wordAt,
  applySuggestion,
  describeTokens,
} from "@/lib/search-query";
import { EMPTY_SEARCH, UNFILED_PROJECT } from "@/lib/search";
import type { Project, SearchFacets } from "@/lib/types";

/**
 * The grammar behind the one search box.
 *
 * Every test here is a way the box can be wrong while looking completely right.
 * A quote that swallows the rest of the line returns nothing and blames the
 * archive. A value resolved by prefix against two speakers answers a question
 * about Priya with Priyanka's lines, with nothing on screen to reveal it. A
 * filter that survives being deleted from the text keeps narrowing a search
 * nobody can see it narrowing.
 */

const facets: SearchFacets = {
  speakers: ["Priya", "Priyanka", "Marcus"],
  owners: ["Marcus", "Priya"],
  tags: ["q4", "billing"],
  types: ["general", "standup"],
  statuses: ["READY", "FAILED"],
};

const projects: Project[] = [
  { id: "prj_1", name: "Q4 planning", meetingCount: 3, createdAt: "", updatedAt: "" },
  { id: "prj_2", name: "Billing rewrite", meetingCount: 1, createdAt: "", updatedAt: "" },
] as unknown as Project[];

const catalog = { facets, projects };

describe("parsing", () => {
  it("keeps plain words as the search term", () => {
    expect(parseQuery("stripe billing").text).toBe("stripe billing");
    expect(parseQuery("stripe billing").tokens).toHaveLength(0);
  });

  it("pulls a filter out of the middle without disturbing the rest", () => {
    const parsed = parseQuery("what did from:priya say about stripe");

    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]).toMatchObject({ field: "speaker", value: "priya" });
    expect(parsed.text).toBe("what did say about stripe");
  });

  it("keeps a quoted value whole", () => {
    // Unquoted this would filter on "Q4" and search for "planning", which
    // returns nothing and looks like the folder is empty.
    const parsed = parseQuery('in:"Q4 planning" budget');

    expect(parsed.tokens[0].value).toBe("Q4 planning");
    expect(parsed.text).toBe("budget");
  });

  it("treats an unterminated quote as running to the end", () => {
    // What somebody halfway through typing one has. Refusing to parse it would
    // make the suggestions vanish exactly when they are needed.
    expect(parseQuery('in:"Q4 plan').tokens[0].value).toBe("Q4 plan");
  });

  it("accepts every spelling of a field", () => {
    expect(parseQuery("from:priya").tokens[0].field).toBe("speaker");
    expect(parseQuery("speaker:priya").tokens[0].field).toBe("speaker");
    expect(parseQuery("in:sales").tokens[0].field).toBe("project");
    expect(parseQuery("folder:sales").tokens[0].field).toBe("project");
  });

  it("leaves an unknown prefix as ordinary text", () => {
    // "http://example.com" and "note: remember this" both contain a colon and
    // neither is a filter.
    const parsed = parseQuery("note:remember");
    expect(parsed.tokens).toHaveLength(0);
    expect(parsed.text).toBe("note:remember");
  });
});

describe("resolving against the workspace", () => {
  it("matches a speaker exactly, whatever the case", () => {
    expect(toSearchState(parseQuery("from:priya"), catalog).speaker).toBe("Priya");
  });

  it("completes an unambiguous prefix", () => {
    expect(toSearchState(parseQuery("from:marc"), catalog).speaker).toBe("Marcus");
  });

  it("refuses a prefix that matches two people", () => {
    // "pri" is both Priya and Priyanka. Picking the first would answer a
    // question about one with the other's lines, invisibly.
    expect(toSearchState(parseQuery("from:pri"), catalog).speaker).toBe("");
  });

  it("drops a value the workspace does not have", () => {
    // Passing it through returns an empty page that looks like a broken search;
    // dropping it returns everything else and makes the typo obvious.
    expect(toSearchState(parseQuery("from:nobody stripe"), catalog).speaker).toBe("");
    expect(toSearchState(parseQuery("from:nobody stripe"), catalog).q).toBe("stripe");
  });

  it("resolves a folder to its id", () => {
    expect(toSearchState(parseQuery('in:"Q4 planning"'), catalog).project).toBe("prj_1");
  });

  it("treats unfiled as a real answer rather than an absence", () => {
    expect(toSearchState(parseQuery("in:unfiled"), catalog).project).toBe(UNFILED_PROJECT);
  });

  it("reads a time frame by name or by label", () => {
    expect(toSearchState(parseQuery("when:week"), catalog).date).toBe("week");
    expect(toSearchState(parseQuery("when:today"), catalog).date).toBe("today");
  });

  it("carries several filters at once", () => {
    const state = toSearchState(parseQuery('from:marcus tag:q4 when:month decided:yes budget'), catalog);

    expect(state).toMatchObject({
      speaker: "Marcus",
      tag: "q4",
      date: "month",
      withDecisions: true,
      q: "budget",
    });
  });

  it("starts from a clean state, so a removed filter really goes", () => {
    // The box is re-parsed on every keystroke. If the previous state leaked
    // through, deleting `from:priya` from the text would leave the search still
    // narrowed to her with nothing on screen saying so.
    const previous = { ...EMPTY_SEARCH, speaker: "Priya", tag: "q4" };
    const state = toSearchState(parseQuery("stripe"), catalog, previous);

    expect(state.speaker).toBe("");
    expect(state.tag).toBe("");
  });

  it("keeps the mode and the open group, which are not filters", () => {
    const previous = { ...EMPTY_SEARCH, mode: "meaning" as const, group: "mentions" as const };
    const state = toSearchState(parseQuery("stripe"), catalog, previous);

    expect(state.mode).toBe("meaning");
    expect(state.group).toBe("mentions");
  });
});

describe("writing a search back out", () => {
  it("round-trips through the text and back", () => {
    const original = toSearchState(parseQuery('from:marcus in:"Q4 planning" when:week stripe'), catalog);
    const text = formatQuery(original, catalog);

    expect(toSearchState(parseQuery(text), catalog)).toMatchObject({
      speaker: "Marcus",
      project: "prj_1",
      date: "week",
      q: "stripe",
    });
  });

  it("quotes only what needs it", () => {
    const state = { ...EMPTY_SEARCH, speaker: "Marcus", project: "prj_1" };
    expect(formatQuery(state, catalog)).toBe('from:Marcus in:"Q4 planning"');
  });

  it("says nothing about a filter that is not set", () => {
    expect(formatQuery({ ...EMPTY_SEARCH, q: "stripe" }, catalog)).toBe("stripe");
  });
});

describe("suggestions", () => {
  it("offers filters for a partial key", () => {
    const shown = suggestFor("fr", catalog);
    expect(shown.map((s) => s.insert)).toContain("from:");
  });

  it("offers the workspace's own values after a colon", () => {
    const shown = suggestFor("from:pri", catalog);
    expect(shown.map((s) => s.label)).toEqual(["Priya", "Priyanka"]);
  });

  it("offers folders and unfiled for in:", () => {
    expect(suggestFor("in:", catalog).map((s) => s.label)).toEqual([
      "Q4 planning",
      "Billing rewrite",
      "unfiled",
    ]);
  });

  it("stays silent for an ordinary word", () => {
    // A box that completes plain terms is guessing at what somebody meant, and
    // gets in the way of the far commoner case of typing exactly that.
    expect(suggestFor("stripe", catalog)).toHaveLength(0);
  });

  it("stays silent for a prefix nothing answers to", () => {
    expect(suggestFor("colour:", catalog)).toHaveLength(0);
  });
});

describe("completing what is being typed", () => {
  it("finds the word under the cursor", () => {
    expect(wordAt("from:pri stripe", 8)).toEqual({ word: "from:pri", start: 0 });
    expect(wordAt("from:pri stripe", 15).word).toBe("stripe");
  });

  it("treats a quoted run as one word", () => {
    expect(wordAt('in:"Q4 pla', 10).word).toBe('in:"Q4 pla');
  });

  it("leaves the cursor inside a filter so the value can be typed", () => {
    const next = applySuggestion("fr", 2, {
      insert: "from:",
      label: "from:",
      hint: "",
      kind: "filter",
    });
    expect(next.text).toBe("from:");
    expect(next.cursor).toBe(5);
  });

  it("moves past a completed value, adding the space", () => {
    const next = applySuggestion("from:pri", 8, {
      insert: 'from:"Priya"',
      label: "Priya",
      hint: "",
      kind: "value",
    });
    expect(next.text).toBe('from:"Priya" ');
    expect(next.cursor).toBe(13);
  });

  it("replaces only the word under the cursor", () => {
    const next = applySuggestion("stripe fr budget", 9, {
      insert: "from:",
      label: "from:",
      hint: "",
      kind: "filter",
    });
    expect(next.text).toBe("stripe from: budget");
  });
});

describe("describing what a query narrows to", () => {
  it("names each filter in the words the box uses", () => {
    expect(describeTokens(parseQuery('from:priya in:"Q4 planning"'))).toEqual([
      { label: "from", value: "priya" },
      { label: "in", value: "Q4 planning" },
    ]);
  });

  it("leaves out a filter that has not been given a value yet", () => {
    expect(describeTokens(parseQuery("from:"))).toHaveLength(0);
  });
});
