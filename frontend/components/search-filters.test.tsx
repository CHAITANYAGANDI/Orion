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

    for (const label of ["Date", "Speaker", "Meeting type", "Tag", "Status", "Action owner"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Settled a decision" })).toBeInTheDocument();
  });

  it("hides a filter with nothing to filter by", () => {
    // Nobody has been assigned a commitment yet. An owner dropdown with one
    // dead row invites a click that does nothing.
    renderBar({}, { ...FACETS, owners: [], tags: [] });

    expect(screen.queryByLabelText("Action owner")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tag")).not.toBeInTheDocument();
    // Date needs no data behind it, so it survives an empty workspace.
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
  });

  it("renders nothing but the date filter before anything is processed", () => {
    // Facets have not arrived yet, or the workspace is brand new.
    render(<SearchFilters state={EMPTY_SEARCH} onChange={onChange} />);

    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.queryByLabelText("Speaker")).not.toBeInTheDocument();
  });

  it("commits a choice on the first click", async () => {
    renderBar();

    await userEvent.click(screen.getByLabelText("Speaker"));
    await userEvent.click(screen.getByRole("option", { name: "Priya" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ speaker: "Priya" }));
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
    await userEvent.click(screen.getByRole("option", { name: "Unfiled" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ project: "none" }));
  });

  it("hides the project filter in a workspace with no projects", () => {
    render(
      <SearchFilters state={EMPTY_SEARCH} facets={FACETS} projects={[]} onChange={onChange} />,
    );

    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("lets a filter be taken off again", async () => {
    renderBar({ speaker: "Priya" });

    await userEvent.click(screen.getByLabelText("Speaker"));
    await userEvent.click(screen.getByRole("option", { name: "Anyone" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ speaker: "" }));
  });

  it("toggles the decision filter both ways", async () => {
    const { rerender } = renderBar();
    const toggle = screen.getByRole("button", { name: "Settled a decision" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ withDecisions: true }));

    rerender(
      <SearchFilters
        state={{ ...EMPTY_SEARCH, withDecisions: true }}
        facets={FACETS}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Settled a decision" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows how many filters are on, and clears them together", async () => {
    renderBar({ q: "stripe", speaker: "Priya", date: "week", withDecisions: true });

    const clear = screen.getByRole("button", { name: /Clear 3 filters/ });
    await userEvent.click(clear);

    // Clearing filters is not clearing the search: the term survives.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ q: "stripe", speaker: "", date: "any", withDecisions: false }),
    );
  });

  it("offers nothing to clear when nothing is set", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
  });
});
