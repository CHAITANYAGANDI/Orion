import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, SearchFacets, SearchResponse } from "@/lib/types";

/**
 * The search page.
 *
 * <p>What is worth asserting here is not that results render — it is that the
 * page asks the right question. A search box that fires on every keystroke, a
 * "see all" that re-runs five queries to show one of them, or a set of counts
 * that blank out the moment you open a group: each of those is invisible in a
 * screenshot and obvious in a network tab.
 *
 * <p>The empty state gets its own attention, because it is the state the page
 * is in most of the time — a search screen that shows nothing until you type is
 * a screen that has to be earned before it is useful.
 */
const { searchQuery, semanticSearch } = vi.hoisted(() => ({
  searchQuery: vi.fn(),
  semanticSearch: vi.fn(),
}));

let results: SearchResponse;
let facets: SearchFacets | undefined;
let projects: Project[];

vi.mock("@/lib/api", () => ({
  useSearchQuery: (args: unknown, opts?: { skip?: boolean }) => {
    if (!opts?.skip) searchQuery(args);
    return { data: opts?.skip ? undefined : results, isLoading: false };
  },
  useGetSearchFacetsQuery: () => ({ data: facets }),
  useGetProjectsQuery: () => ({ data: projects }),
  useGetSummaryTemplatesQuery: () => ({
    data: [{ slug: "one-on-one", name: "1:1", sectionTitles: [] }],
  }),
  useSemanticSearchMutation: () => [
    (a: unknown) => {
      semanticSearch(a);
      return { unwrap: vi.fn() };
    },
    { isLoading: false, data: undefined },
  ],
}));

import SearchPage from "@/app/(app)/search/page";

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "stripe",
    meetings: {
      total: 2,
      hits: [
        {
          id: "mtg_1",
          title: "Stripe migration",
          status: "READY",
          createdAt: "2026-08-01T10:00:00Z",
          durationSeconds: 1800,
          tags: ["finance"],
          summaryTemplate: "general",
          mentions: 0,
          titleMatch: true,
        },
        {
          id: "mtg_2",
          title: "Weekly sync",
          status: "READY",
          createdAt: "2026-07-28T10:00:00Z",
          durationSeconds: 900,
          tags: [],
          summaryTemplate: "standup",
          mentions: 4,
          titleMatch: false,
        },
      ],
    },
    people: {
      total: 1,
      hits: [{ name: "Priya", meetings: 3, segments: 42, mentions: 8, commitments: 2 }],
    },
    decisions: {
      total: 1,
      hits: [
        {
          id: "ins_1",
          meetingId: "mtg_1",
          meetingTitle: "Stripe migration",
          meetingCreatedAt: "2026-08-01T10:00:00Z",
          kind: "DECISION",
          text: "Move billing to Stripe in Q4",
        },
      ],
    },
    risks: { total: 0, hits: [] },
    commitments: {
      total: 1,
      hits: [
        {
          id: "act_1",
          meetingId: "mtg_1",
          meetingTitle: "Stripe migration",
          meetingCreatedAt: "2026-08-01T10:00:00Z",
          title: "Draft the Stripe rollout plan",
          owner: "Marcus",
          status: "OPEN",
          dueDate: "2026-08-20",
          priority: "high",
        },
      ],
    },
    mentions: {
      total: 27,
      hits: [
        {
          segmentId: "seg_1",
          meetingId: "mtg_2",
          meetingTitle: "Weekly sync",
          meetingCreatedAt: "2026-07-28T10:00:00Z",
          speaker: "Priya",
          start: 942.4,
          text: "We should move the billing over to Stripe before the freeze.",
        },
      ],
    },
    ...over,
  };
}

const EMPTY: SearchResponse = {
  query: "",
  meetings: { total: 0, hits: [] },
  people: { total: 0, hits: [] },
  decisions: { total: 0, hits: [] },
  risks: { total: 0, hits: [] },
  commitments: { total: 0, hits: [] },
  mentions: { total: 0, hits: [] },
};

/** The arguments of the most recent search the page actually made. */
function lastQuery() {
  return searchQuery.mock.calls.at(-1)?.[0] as
    | { q: string; groups?: string[]; limit?: number; speaker?: string; project?: string }
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  results = response();
  facets = { speakers: ["Priya"], tags: ["finance"], owners: [], types: [], statuses: [] };
  projects = [
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
  window.history.replaceState(null, "", "/search");
});

describe("SearchPage results", () => {
  it("groups the counts so the shape of the answer is visible", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    // "27 transcript mentions, 1 decision" is the answer to "where does this
    // live" — which is the question a single flat list cannot answer.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Transcript mentions 27/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Decisions 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Risks 0/ })).toBeInTheDocument();
  });

  it("says why a meeting with an unrelated title matched", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText("Weekly sync")).toBeInTheDocument());
    expect(screen.getByText(/4 mentions/)).toBeInTheDocument();
  });

  it("counts a person's speaking, mentions and commitments separately", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "priya");

    // Somebody can be the most mentioned person in the archive, and the one who
    // owes the most, having attended nothing; one merged number hides that.
    await waitFor(() =>
      expect(
        screen.getByText(/spoke in 3 meetings.*mentioned 8 times.*2 commitments/),
      ).toBeInTheDocument(),
    );
  });

  it("leaves out the counts that are zero", async () => {
    results = response({
      people: {
        total: 1,
        hits: [{ name: "Marcus", meetings: 1, segments: 4, mentions: 0, commitments: 0 }],
      },
    });
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "marcus");

    // "0 commitments" reads as a finding rather than as an absence.
    await waitFor(() => expect(screen.getByText("spoke in 1 meeting")).toBeInTheDocument());
  });

  it("links a mention to its own second of the recording", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText(/before the freeze/)).toBeInTheDocument());
    const link = screen.getByText(/before the freeze/).closest("a");
    expect(link).toHaveAttribute("href", "/meetings/mtg_2?t=942");
  });

  it("waits for typing to settle before searching", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    // Six keystrokes must not be six searches across six tables.
    await waitFor(() => expect(lastQuery()?.q).toBe("stripe"));
    const terms = searchQuery.mock.calls.map((c) => (c[0] as { q: string }).q);
    expect(terms).not.toContain("stri");
  });
});

describe("SearchPage groups", () => {
  it("asks only for the group that was opened", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");
    await waitFor(() => expect(screen.getByText(/See all 27/)).toBeInTheDocument());

    await userEvent.click(screen.getByText(/See all 27/));

    // Paging into one group should not re-run four queries whose results are
    // not on screen.
    await waitFor(() => expect(lastQuery()?.groups).toEqual(["mentions"]));
    expect(lastQuery()?.limit).toBe(50);
  });

  it("keeps every count while one group is open", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");
    await waitFor(() => expect(screen.getByText(/See all 27/)).toBeInTheDocument());

    await userEvent.click(screen.getByText(/See all 27/));

    // The deep query answers one group. Reading the tab counts from it would
    // blank the other five and imply the results had gone away.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Decisions 1/ })).toBeInTheDocument(),
    );
  });

  it("offers see-all only when there is more than was shown", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText(/See all 27/)).toBeInTheDocument());
    // One decision, one row: there is nothing behind the link.
    expect(screen.queryByText("See all 1")).not.toBeInTheDocument();
  });
});

describe("SearchPage empty states", () => {
  it("opens on recent meetings rather than an empty screen", () => {
    render(<SearchPage />);

    expect(screen.getByText("Recent meetings")).toBeInTheDocument();
    // Counts of nothing, above a list of everything, would be noise.
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("searches with filters and no search term", async () => {
    render(<SearchPage />);

    await userEvent.click(screen.getByLabelText("Speaker"));
    await userEvent.click(screen.getByRole("option", { name: "Priya" }));

    // "Everything Priya spoke in" is a question with no words in it.
    await waitFor(() => expect(lastQuery()?.speaker).toBe("Priya"));
    expect(screen.queryByText("Recent meetings")).not.toBeInTheDocument();
  });

  it("offers meaning search when the exact term finds nothing", async () => {
    results = EMPTY;
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    // Exact search fails on wording, not on subject — the one moment where
    // paying for an embedding is obviously worth it.
    const offer = await screen.findByText("Try searching by meaning");
    await userEvent.click(offer);

    await waitFor(() =>
      expect(semanticSearch).toHaveBeenCalledWith({ query: "budget pushback", limit: 20 }),
    );
  });
});

describe("SearchPage address bar", () => {
  it("puts the search in the URL so it can be reloaded or sent", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(window.location.search).toBe("?q=stripe"));
  });

  it("opens the search the URL describes", () => {
    window.history.replaceState(null, "", "/search?q=stripe&group=mentions&speaker=Priya");

    render(<SearchPage />);

    expect(screen.getByLabelText("Search")).toHaveValue("stripe");
    expect(lastQuery()?.groups).toEqual(["mentions"]);
    expect(lastQuery()?.speaker).toBe("Priya");
  });

  it("opens a project's search from a link", () => {
    // What "Search in project" on the project page produces.
    window.history.replaceState(null, "", "/search?project=prj_1");

    render(<SearchPage />);

    expect(lastQuery()?.project).toBe("prj_1");
    // A filter is a search, so the browse view is not what shows.
    expect(screen.queryByText("Recent meetings")).not.toBeInTheDocument();
  });

  it("leaves nothing in the URL for a search nobody has made", () => {
    render(<SearchPage />);

    // Eight empty parameters would suggest choices somebody made.
    expect(window.location.search).toBe("");
  });
});
