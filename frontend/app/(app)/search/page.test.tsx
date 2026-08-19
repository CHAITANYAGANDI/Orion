import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Project,
  SearchFacets,
  SearchResponse,
  SemanticSearchHit,
} from "@/lib/types";

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
 *
 * <p>And meaning search is no longer a mode. It runs with every settled query
 * and its results sit under the exact ones, which makes two things testable that
 * a toggle hid: that it is asked for at all, and that it is not asked for two
 * characters at a time on the way to a word.
 */
const { searchQuery, semanticSearch } = vi.hoisted(() => ({
  searchQuery: vi.fn(),
  semanticSearch: vi.fn(),
}));

let results: SearchResponse;
let facets: SearchFacets | undefined;
let projects: Project[];
let meaningHits: SemanticSearchHit[] | undefined;

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
    { isLoading: false, data: meaningHits },
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
    | { q: string; groups?: string[]; limit?: number; tag?: string; project?: string }
    | undefined;
}

const MEANING: SemanticSearchHit[] = [
  {
    meetingId: "mtg_3",
    meetingTitle: "Finance review",
    meetingStatus: "READY",
    meetingCreatedAt: "2026-07-20T10:00:00Z",
    chunkIndex: 2,
    snippet: "They pushed back hard on the numbers for next quarter.",
    start: 120,
    score: 0.82,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  results = response();
  meaningHits = undefined;
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

    // "2 meetings, 27 transcript mentions" is the answer to "where does this
    // live" — which is the question a single flat list cannot answer.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Transcript mentions 27/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Meetings 2/ })).toBeInTheDocument();
  });

  it("lists conversations and what was said in them, and nothing else", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    // People, decisions, commitments and risks were four more ways of arriving
    // at a meeting already on the page. The server still answers with them; the
    // page must not grow them back.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Transcript mentions 27/ })).toBeInTheDocument(),
    );
    for (const gone of [/People/, /Decisions/, /Commitments/, /Risks/]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    // And their contents are not on screen under some other heading.
    expect(screen.queryByText("Move billing to Stripe in Q4")).not.toBeInTheDocument();
    expect(screen.queryByText("Draft the Stripe rollout plan")).not.toBeInTheDocument();
  });

  it("says why a meeting with an unrelated title matched", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText("Weekly sync")).toBeInTheDocument());
    expect(screen.getByText(/4 mentions/)).toBeInTheDocument();
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
    // blank the other and imply those results had gone away.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Meetings 2/ })).toBeInTheDocument(),
    );
  });

  it("asks the API only for the groups it draws", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    // An absent list means every group the server has. Four of those are no
    // longer rendered, and asking for them is four more searches across four
    // more tables whose answers are dropped on arrival.
    await waitFor(() => expect(lastQuery()?.q).toBe("stripe"));
    expect(lastQuery()?.groups).toEqual(["meetings", "mentions"]);
  });

  it("offers see-all only when there is more than was shown", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText(/See all 27/)).toBeInTheDocument());
    // Two meetings, two rows: there is nothing behind the link.
    expect(screen.queryByText("See all 2")).not.toBeInTheDocument();
  });
});

describe("SearchPage empty states", () => {
  it("opens by saying what the box reaches, not by listing meetings", () => {
    render(<SearchPage />);

    // A list of recent meetings here is Home with a search box over it: five
    // rows nobody came to this page to read.
    expect(screen.getByText("Search everything you have recorded")).toBeInTheDocument();
    expect(screen.queryByText("Recent meetings")).not.toBeInTheDocument();
    expect(screen.queryByText("Stripe migration")).not.toBeInTheDocument();
    // Counts of nothing, above a list of everything, would be noise.
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("searches with filters and no search term", async () => {
    render(<SearchPage />);

    await userEvent.click(screen.getByLabelText("Tag"));
    await userEvent.click(screen.getByRole("option", { name: "finance" }));

    // "Everything tagged finance" is a question with no words in it.
    await waitFor(() => expect(lastQuery()?.tag).toBe("finance"));
    expect(
      screen.queryByText("Search everything you have recorded"),
    ).not.toBeInTheDocument();
  });

  it("says nothing matched only once both halves have failed", async () => {
    results = EMPTY;
    meaningHits = [];
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    expect(await screen.findByText(/Nothing in your workspace matches/)).toBeInTheDocument();
  });

  it("does not claim nothing matched while the meaning results are on screen", async () => {
    // The exact search failing on wording is the ordinary case the meaning
    // search exists for. "Nothing matches", printed above a list of things that
    // do, is a lie with the evidence directly underneath it.
    results = EMPTY;
    meaningHits = MEANING;
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    await waitFor(() => expect(screen.getByText("Finance review")).toBeInTheDocument());
    expect(screen.queryByText(/Nothing in your workspace matches/)).not.toBeInTheDocument();
  });
});

describe("SearchPage meaning", () => {
  it("asks by meaning as well as by words, without being asked to", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    // The toggle this replaces asked somebody to decide, before searching,
    // whether the words they were about to type are the words that were said.
    await waitFor(() =>
      expect(semanticSearch).toHaveBeenCalledWith({ query: "budget pushback", limit: 10 }),
    );
  });

  it("does not pay to embed a query too short to mean anything", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "st");

    await waitFor(() => expect(lastQuery()?.q).toBe("st"));
    // One embedding per settled query is the deal. "st" on the way to "stripe"
    // has no meaning to match and is not worth a model call.
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it("labels the meaning hits rather than mixing them into the exact ones", async () => {
    meaningHits = MEANING;
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    // A passage with none of the search terms in it, sitting unannounced among
    // ones that have them, reads as a broken search rather than a feature.
    await waitFor(() => expect(screen.getByText("Close in meaning")).toBeInTheDocument());
    expect(screen.getByText(/pushed back hard on the numbers/)).toBeInTheDocument();
    expect(screen.getByText("82% match")).toBeInTheDocument();
  });

  it("links a meaning hit to the second it was said", async () => {
    meaningHits = MEANING;
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "budget pushback");

    await waitFor(() => expect(screen.getByText("Finance review")).toBeInTheDocument());
    expect(screen.getByText("Finance review").closest("a")).toHaveAttribute(
      "href",
      "/meetings/mtg_3?t=120",
    );
  });

  it("does not list a passage the words already found", async () => {
    // What "hello" looked like: the two sentences containing it, shown under
    // Transcript mentions and then again as the nearest things in the index.
    meaningHits = [
      {
        meetingId: "mtg_2",
        meetingTitle: "Weekly sync",
        meetingStatus: "READY",
        meetingCreatedAt: "2026-07-28T10:00:00Z",
        chunkIndex: 0,
        snippet: "We should move the billing over to Stripe before the freeze.",
        start: 942.4,
        score: 0.44,
      },
    ];
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText(/before the freeze/)).toBeInTheDocument());
    expect(screen.queryByText("Close in meaning")).not.toBeInTheDocument();
  });

  it("does not list noise the index returned because it had to return something", async () => {
    // Nearest-neighbour search has no idea of "no match".
    meaningHits = MEANING.map((h) => ({ ...h, score: 0.22 }));
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(screen.getByText("Weekly sync")).toBeInTheDocument());
    expect(screen.queryByText("Close in meaning")).not.toBeInTheDocument();
  });

  it("shows nothing at all when the meaning search finds nothing", async () => {
    meaningHits = [];
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    // An empty "Close in meaning" under a full page of results is a report of
    // failure for something nobody asked for.
    await waitFor(() => expect(screen.getByText("Weekly sync")).toBeInTheDocument());
    expect(screen.queryByText("Close in meaning")).not.toBeInTheDocument();
  });
});

describe("SearchPage address bar", () => {
  it("puts the search in the URL so it can be reloaded or sent", async () => {
    render(<SearchPage />);
    await userEvent.type(screen.getByLabelText("Search"), "stripe");

    await waitFor(() => expect(window.location.search).toBe("?q=stripe"));
  });

  it("opens the search the URL describes", () => {
    window.history.replaceState(null, "", "/search?q=stripe&group=mentions&tag=finance");

    render(<SearchPage />);

    expect(screen.getByLabelText("Search")).toHaveValue("stripe");
    expect(lastQuery()?.groups).toEqual(["mentions"]);
    expect(lastQuery()?.tag).toBe("finance");
  });

  it("opens a project's search from a link", () => {
    // What "Search in project" on the project page produces.
    window.history.replaceState(null, "", "/search?project=prj_1");

    render(<SearchPage />);

    expect(lastQuery()?.project).toBe("prj_1");
    // A filter is a search, so the resting state is not what shows.
    expect(
      screen.queryByText("Search everything you have recorded"),
    ).not.toBeInTheDocument();
  });

  it("leaves nothing in the URL for a search nobody has made", () => {
    render(<SearchPage />);

    // Eight empty parameters would suggest choices somebody made.
    expect(window.location.search).toBe("");
  });
});
