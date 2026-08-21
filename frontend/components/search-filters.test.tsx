import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchFilters } from "@/components/search-filters";
import { EMPTY_SEARCH, type SearchState } from "@/lib/search";
import type { Project, SearchFacets } from "@/lib/types";

/**
 * The filter bar.
 *
 * <p>The counting and clearing live in `lib/search`; what is left here is the
 * part that only exists on screen. Two things matter. A dropdown offering
 * values the workspace does not have is a control that returns nothing and
 * looks broken — so a facet with no values is not rendered at all. And a filter
 * has to commit immediately: unlike the search box there is nothing to debounce,
 * and a select that needs a second click to take effect reads as a bug.
 *
 * <p>The third is the one this bar was cut down for. There are four controls,
 * and the removed ones are asserted absent rather than left to drift back: a
 * dropdown here that the results page has no state to hold would narrow a
 * search with nothing on screen to say so.
 */
const FACETS: SearchFacets = {
  speakers: ["Priya", "Marcus"],
  tags: ["finance"],
  owners: ["Marcus"],
  types: ["one-on-one", "standup"],
  statuses: ["READY"],
};

const onChange = vi.fn();

const PROJECTS: Project[] = [
  {
    id: "prj_1",
    name: "Client ABC",
    description: "",
    color: "",
    favorite: false,
    meetingCount: 3,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
  },
];

function renderBar(state: Partial<SearchState> = {}, facets: SearchFacets | undefined = FACETS) {
  return render(
    <SearchFilters
      state={{ ...EMPTY_SEARCH, ...state }}
      facets={facets}
      typeLabels={{ "one-on-one": "1:1", standup: "Standup" }}
      projects={PROJECTS}
      onChange={onChange}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SearchFilters", () => {
  it("offers a filter for everything the workspace has", () => {
    renderBar();

    for (const label of ["Date", "Meeting type", "Tag", "Project"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("no longer offers the four that were taken away", () => {
    // Speaker and status narrowed a page that now shows two kinds of result;
    // action owner and "settled a decision" narrowed lists it no longer shows
    // at all. None of them has state behind it any more — see lib/search.ts.
    renderBar();

    for (const label of ["Speaker", "Status", "Action owner"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Settled a decision" })).not.toBeInTheDocument();
    // Both dropdowns that read "Anyone" are gone with them.
    expect(screen.queryByText("Anyone")).not.toBeInTheDocument();
  });

  it("hides a filter with nothing to filter by", () => {
    // Nothing has been tagged yet. A tag dropdown with one dead row invites a
    // click that does nothing.
    renderBar({}, { ...FACETS, tags: [], types: [] });

    expect(screen.queryByLabelText("Tag")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Meeting type")).not.toBeInTheDocument();
    // Date needs no data behind it, so it survives an empty workspace.
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
  });

  it("renders nothing but the date filter before anything is processed", () => {
    // Facets have not arrived yet, or the workspace is brand new.
    render(<SearchFilters state={EMPTY_SEARCH} onChange={onChange} />);

    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tag")).not.toBeInTheDocument();
  });

  it("commits a choice on the first click", async () => {
    renderBar();

    await userEvent.click(screen.getByLabelText("Tag"));
    await userEvent.click(screen.getByRole("option", { name: "finance" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tag: "finance" }));
  });

  it("names meeting types the way the product does", async () => {
    // The slug is "one-on-one"; nobody calls it that.
    renderBar();

    await userEvent.click(screen.getByLabelText("Meeting type"));

    expect(screen.getByRole("option", { name: "1:1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "one-on-one" })).not.toBeInTheDocument();
  });

  it("filters by project, including what is filed nowhere", async () => {
    renderBar();

    await userEvent.click(screen.getByLabelText("Project"));

    expect(screen.getByRole("option", { name: "Client ABC" })).toBeInTheDocument();
    // "What have I not sorted yet" is a search, not an empty box.
    await userEvent.click(screen.getByRole("option", { name: "No folder" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ project: "none" }));
  });

  it("hides the project filter in a workspace with no projects", () => {
    render(
      <SearchFilters state={EMPTY_SEARCH} facets={FACETS} projects={[]} onChange={onChange} />,
    );

    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("lets a filter be taken off again", async () => {
    renderBar({ tag: "finance" });

    await userEvent.click(screen.getByLabelText("Tag"));
    await userEvent.click(screen.getByRole("option", { name: "Any tag" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tag: "" }));
  });

  it("shows how many filters are on, and clears them together", async () => {
    renderBar({ q: "stripe", tag: "finance", date: "week", project: "prj_1" });

    const clear = screen.getByRole("button", { name: /Clear 3 filters/ });
    await userEvent.click(clear);

    // Clearing filters is not clearing the search: the term survives.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ q: "stripe", tag: "", date: "any", project: "" }),
    );
  });

  it("offers nothing to clear when nothing is set", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
  });
});
