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
 * archive. A value resolved by prefix against two tags answers a question about
 * `billing` with `billing-migration`, with nothing on screen to reveal it. A
 * filter that survives being deleted from the text keeps narrowing a search
 * nobody can see it narrowing.
 *
 * <p>And the grammar may not outgrow the page. Every filter here has a dropdown
 * on the results screen that shows it and takes it off again; one that did not
 * would be a way of typing a search nobody could see or undo.
 */

const facets: SearchFacets = {
  speakers: ["Priya", "Priyanka", "Marcus"],
  owners: ["Marcus", "Priya"],
  tags: ["q4", "billing", "billing-migration"],
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
    const parsed = parseQuery("what did tag:q4 say about stripe");

    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]).toMatchObject({ field: "tag", value: "q4" });
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
    expect(parseQuery("in:sales").tokens[0].field).toBe("project");
    expect(parseQuery("folder:sales").tokens[0].field).toBe("project");
    expect(parseQuery("project:sales").tokens[0].field).toBe("project");
    expect(parseQuery("when:week").tokens[0].field).toBe("date");
    expect(parseQuery("date:week").tokens[0].field).toBe("date");
  });

  it("no longer answers to the filters the results page dropped", () => {
    // from:, owner:, status: and decided: went with the speaker, owner, status
    // and decision controls. Parsing them would set a filter the page has no
    // dropdown to show and no way to clear.
    for (const dead of ["from:priya", "speaker:priya", "owner:marcus", "status:ready", "decided:yes"]) {
      expect(parseQuery(dead).tokens).toHaveLength(0);
    }
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
  it("matches a tag exactly, whatever the case", () => {
    expect(toSearchState(parseQuery("tag:Q4"), catalog).tag).toBe("q4");
  });

  it("completes an unambiguous prefix", () => {
    expect(toSearchState(parseQuery("type:stand"), catalog).type).toBe("standup");
  });

  it("refuses a prefix that matches two values", () => {
    // "bill" is both billing and billing-migration. Picking the first would
    // answer a question about one with the other's meetings, invisibly.
    expect(toSearchState(parseQuery("tag:bill"), catalog).tag).toBe("");
  });

  it("drops a value the workspace does not have", () => {
    // Passing it through returns an empty page that looks like a broken search;
    // dropping it returns everything else and makes the typo obvious.
    expect(toSearchState(parseQuery("tag:nothing stripe"), catalog).tag).toBe("");
    expect(toSearchState(parseQuery("tag:nothing stripe"), catalog).q).toBe("stripe");
  });

  it("resolves a folder to its id", () => {
    expect(toSearchState(parseQuery('in:"Q4 planning"'), catalog).project).toBe("prj_1");
  });

  it("treats none as a real answer rather than an absence", () => {
    expect(toSearchState(parseQuery("in:none"), catalog).project).toBe(UNFILED_PROJECT);
  });

  it("reads a time frame by name or by label", () => {
    expect(toSearchState(parseQuery("when:week"), catalog).date).toBe("week");
    expect(toSearchState(parseQuery("when:today"), catalog).date).toBe("today");
  });

  it("carries several filters at once", () => {
    const state = toSearchState(parseQuery('in:"Q4 planning" tag:q4 when:month budget'), catalog);

    expect(state).toMatchObject({
      project: "prj_1",
      tag: "q4",
      date: "month",
      q: "budget",
    });
  });

  it("starts from a clean state, so a removed filter really goes", () => {
    // The box is re-parsed on every keystroke. If the previous state leaked
    // through, deleting `tag:q4` from the text would leave the search still
    // narrowed to it with nothing on screen saying so.
    const previous = { ...EMPTY_SEARCH, type: "standup", tag: "q4" };
    const state = toSearchState(parseQuery("stripe"), catalog, previous);

    expect(state.type).toBe("");
    expect(state.tag).toBe("");
  });

  it("keeps the open group, which is not a filter", () => {
    const previous = { ...EMPTY_SEARCH, group: "mentions" as const };
    const state = toSearchState(parseQuery("stripe"), catalog, previous);

    expect(state.group).toBe("mentions");
  });
});

describe("writing a search back out", () => {
  it("round-trips through the text and back", () => {
    const original = toSearchState(parseQuery('tag:q4 in:"Q4 planning" when:week stripe'), catalog);
    const text = formatQuery(original, catalog);

    expect(toSearchState(parseQuery(text), catalog)).toMatchObject({
      tag: "q4",
      project: "prj_1",
      date: "week",
      q: "stripe",
    });
  });

  it("quotes only what needs it", () => {
    const state = { ...EMPTY_SEARCH, tag: "q4", project: "prj_1" };
    expect(formatQuery(state, catalog)).toBe('in:"Q4 planning" tag:q4');
  });

  it("says nothing about a filter that is not set", () => {
    expect(formatQuery({ ...EMPTY_SEARCH, q: "stripe" }, catalog)).toBe("stripe");
  });
});

describe("suggestions", () => {
  it("offers filters for a partial key", () => {
    const shown = suggestFor("ta", catalog);
    expect(shown.map((s) => s.insert)).toContain("tag:");
  });

  it("offers the workspace's own values after a colon", () => {
    const shown = suggestFor("tag:bill", catalog);
    expect(shown.map((s) => s.label)).toEqual(["billing", "billing-migration"]);
  });

  it("offers nothing for a filter the page no longer has", () => {
    expect(suggestFor("from:", catalog)).toHaveLength(0);
    expect(suggestFor("owner:", catalog)).toHaveLength(0);
  });

  it("offers folders and none for in:", () => {
    expect(suggestFor("in:", catalog).map((s) => s.label)).toEqual([
      "Q4 planning",
      "Billing rewrite",
      "none",
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
    expect(wordAt("tag:bill stripe", 8)).toEqual({ word: "tag:bill", start: 0 });
    expect(wordAt("tag:bill stripe", 15).word).toBe("stripe");
  });

  it("treats a quoted run as one word", () => {
    expect(wordAt('in:"Q4 pla', 10).word).toBe('in:"Q4 pla');
  });

  it("leaves the cursor inside a filter so the value can be typed", () => {
    const next = applySuggestion("ta", 2, {
      insert: "tag:",
      label: "tag:",
      hint: "",
      kind: "filter",
    });
    expect(next.text).toBe("tag:");
    expect(next.cursor).toBe(4);
  });

  it("moves past a completed value, adding the space", () => {
    const next = applySuggestion("in:Q4", 5, {
      insert: 'in:"Q4 planning"',
      label: "Q4 planning",
      hint: "",
      kind: "value",
    });
    expect(next.text).toBe('in:"Q4 planning" ');
    expect(next.cursor).toBe(17);
  });

  it("replaces only the word under the cursor", () => {
    const next = applySuggestion("stripe ta budget", 9, {
      insert: "tag:",
      label: "tag:",
      hint: "",
      kind: "filter",
    });
    expect(next.text).toBe("stripe tag: budget");
  });
});

describe("describing what a query narrows to", () => {
  it("names each filter in the words the box uses", () => {
    expect(describeTokens(parseQuery('tag:q4 in:"Q4 planning"'))).toEqual([
      { label: "tag", value: "q4" },
      { label: "in", value: "Q4 planning" },
    ]);
  });

  it("leaves out a filter that has not been given a value yet", () => {
    expect(describeTokens(parseQuery("tag:"))).toHaveLength(0);
  });
});
