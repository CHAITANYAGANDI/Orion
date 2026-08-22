import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, SearchFacets, SearchResponse } from "@/lib/types";
import { rememberSearch, readRecentSearches } from "@/lib/recent-searches";

/**
 * The search overlay.
 *
 * <p>It answers. That is the thing worth pinning down here, because it did not:
 * typing an ordinary word showed a blank panel, since the only thing the box
 * had to offer was completions for filter prefixes and "product" is not one. A
 * search box that displays nothing while you type reads as broken, and the
 * tests below are mostly about it not being able to become that again.
 *
 * <p>And it is the only search there is. There used to be a /search page behind
 * it, reached by pressing Enter — which is where the second failure lived:
 * Enter, and a click on a remembered search, both left this box for a page that
 * showed nothing. Enter opens a result now, and a remembered search runs here.
 * Both are asserted below, and so is the absence of anything that navigates to
 * a results page.
 *
 * <p>The rest is the grammar. And a half-typed filter never becomes a search:
 * `tag:bil` submitted as free text returns nothing and blames the archive.
 */
const { push, searchQuery } = vi.hoisted(() => ({ push: vi.fn(), searchQuery: vi.fn() }));

const facets: SearchFacets = {
  speakers: ["Priya", "Marcus"],
  owners: ["Marcus"],
  tags: ["q4"],
  types: ["standup"],
  statuses: ["READY"],
};

const projects = [
  { id: "prj_1", name: "Q4 planning" },
] as unknown as Project[];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ userId: "usr_1" }) }));

// The real store, not a mock: it is the thing being relied on here, and it
// reads and writes the jsdom localStorage that each test clears.

let results: SearchResponse;
let fetching = false;

vi.mock("@/lib/api", () => ({
  useGetSearchFacetsQuery: () => ({ data: facets }),
  useGetProjectsQuery: () => ({ data: projects }),
  useSearchQuery: (args: unknown, opts?: { skip?: boolean }) => {
    if (!opts?.skip) searchQuery(args);
    return { data: opts?.skip ? undefined : results, isFetching: fetching };
  },
}));

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "product",
    meetings: {
      total: 1,
      hits: [
        {
          id: "mtg_1",
          title: "Product marketing weekly",
          status: "READY",
          createdAt: "2026-08-10T09:00:00Z",
          durationSeconds: 1800,
          tags: [],
          summaryTemplate: "general",
          mentions: 3,
          titleMatch: true,
        },
      ],
    },
    people: { total: 0, hits: [] },
    decisions: { total: 0, hits: [] },
    risks: { total: 0, hits: [] },
    commitments: { total: 0, hits: [] },
    mentions: {
      total: 1,
      hits: [
        {
          segmentId: "seg_1",
          meetingId: "mtg_2",
          meetingTitle: "Weekly sync",
          meetingCreatedAt: "2026-07-28T10:00:00Z",
          speaker: "Priya",
          start: 942.4,
          text: "Ah, product announcements. So I appreciate Brian for adding this.",
        },
      ],
    },
    ...over,
  };
}

const NOTHING: SearchResponse = {
  query: "product",
  meetings: { total: 0, hits: [] },
  people: { total: 0, hits: [] },
  decisions: { total: 0, hits: [] },
  risks: { total: 0, hits: [] },
  commitments: { total: 0, hits: [] },
  mentions: { total: 0, hits: [] },
};

import { SearchCommand } from "@/components/search-command";

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  results = response();
  fetching = false;
  // jsdom has no rAF scheduling worth waiting on; run the focus callback now.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

describe("opening", () => {
  it("shows nothing at all when closed", () => {
    render(<SearchCommand open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
  });

  it("offers what was searched before, once there is any", async () => {
    rememberSearch("usr_1", "tag:q4 budget");
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    // The commonest reason to open a search box is to run something close to
    // the last one.
    expect(screen.getByText(/Recent searches/i)).toBeInTheDocument();
    expect(screen.getByText("tag:q4 budget")).toBeInTheDocument();
  });

  it("runs a remembered search here, in the box it was typed into", async () => {
    rememberSearch("usr_1", "tag:q4 budget");
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByText("tag:q4 budget"));

    // It used to navigate to /search with the query in the URL, which is how
    // clicking a recent search came to show nothing at all.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Search")).toHaveValue("tag:q4 budget");
    // Straight away, without waiting out the settle: it was typed once already.
    expect(await screen.findByText(/marketing weekly/)).toBeInTheDocument();
  });

  it("gets out of the way the moment anything is typed", async () => {
    rememberSearch("usr_1", "stripe");
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Search"), "bil");

    expect(screen.queryByText(/Recent searches/i)).not.toBeInTheDocument();
  });

  it("can be forgotten from the box that shows it", async () => {
    rememberSearch("usr_1", "stripe");
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.queryByText(/Recent searches/i)).not.toBeInTheDocument();
    expect(readRecentSearches("usr_1")).toEqual([]);
  });

  it("opens with nothing in it but the box", () => {
    // The worked examples and the "Try from: in: when: tag:" footer are gone:
    // a help page inside the thing you opened in order to type is read once and
    // in the way every time after.
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    expect(screen.queryByText(/Search everything at once/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tag:q4 budget/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Try$/)).not.toBeInTheDocument();
    // The box survives. What is gone with it now is the button that used to
    // sit at the foot and hand the query to /search.
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Search everything/ })).not.toBeInTheDocument();
  });

  it("says what it searches, which is more than conversations", () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    expect(
      screen.getByPlaceholderText("Search conversations, transcripts, folders, tags"),
    ).toBeInTheDocument();
  });
});

describe("suggesting", () => {
  it("offers a filter as soon as its name is recognisable", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "ta");

    expect(await screen.findByRole("option", { name: /tag:/ })).toBeInTheDocument();
  });

  it("offers the workspace's own tags, not a list to spell from memory", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "tag:");

    expect(await screen.findByRole("option", { name: /q4/ })).toBeInTheDocument();
  });

  it("offers nothing for a prefix the results page can no longer show", async () => {
    // `from:` and `owner:` went with the speaker and action-owner dropdowns.
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "from:");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("offers folders under in:, including none", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "in:");

    expect(await screen.findByRole("option", { name: /Q4 planning/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /none/ })).toBeInTheDocument();
  });

  it("says nothing for an ordinary word", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "stripe");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("completes a chosen value into the box", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText("Search") as HTMLInputElement;
    await user.type(input, "tag:q");
    await user.click(await screen.findByRole("option", { name: /q4/ }));

    await waitFor(() => expect(input.value).toBe("tag:q4 "));
  });
});

describe("answering", () => {
  it("shows results for an ordinary word instead of a blank panel", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    // The whole defect, in one assertion: "product" is not a filter prefix, so
    // before this the panel had nothing to draw and looked broken.
    // Matched on the unmarked half of the title: `highlight` splits it, so
    // "Product" is inside a <mark> and the text node is " marketing weekly".
    expect(await screen.findByText(/marketing weekly/)).toBeInTheDocument();
    expect(screen.getByText(/announcements/)).toBeInTheDocument();
  });

  it("says how many there are", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    expect(await screen.findByText("2 results")).toBeInTheDocument();
  });

  it("marks the term inside the title and inside the sentence", async () => {
    const { container } = render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    await screen.findByText(/marketing weekly/);
    // Two hits, two marks: without them a result is a claim that the word is in
    // there somewhere.
    expect(container.querySelectorAll("mark").length).toBeGreaterThanOrEqual(2);
  });

  it("opens a conversation on click", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    await userEvent.click(await screen.findByText(/marketing weekly/));

    expect(push).toHaveBeenCalledWith("/meetings/mtg_1");
  });

  it("opens a sentence at the second it was said", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    await userEvent.click(await screen.findByText(/announcements/));

    // A mention you cannot jump to is an assertion that the word is in an hour
    // of audio somewhere.
    expect(push).toHaveBeenCalledWith("/meetings/mtg_2?t=942");
  });

  it("walks the list with the arrow keys and opens with Enter", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Search"), "product");
    await screen.findByText(/marketing weekly/);

    // Down from the first result, which is where the selection starts, onto the
    // sentence underneath it — opened at the second it was said.
    await user.keyboard("{ArrowDown}{Enter}");

    expect(push).toHaveBeenCalledWith("/meetings/mtg_2?t=942");
  });

  it("opens the first result on Enter, without the arrows being touched", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText("Search"), "product");
    await screen.findByText(/marketing weekly/);

    await user.keyboard("{Enter}");

    // This used to go to /search, and /search showed nothing for it. The best
    // answer is already on screen and selected; Enter takes it.
    expect(push).toHaveBeenCalledWith("/meetings/mtg_1");
  });

  it("does nothing on Enter before any result has arrived", async () => {
    const user = userEvent.setup();
    fetching = true;
    results = NOTHING;
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    const onOpenChange = vi.fn();
    await user.type(screen.getByLabelText("Search"), "product");

    await user.keyboard("{Enter}");

    // Enter on a list that is not there should leave the box open rather than
    // close it on nothing, which is what made this feel broken.
    expect(push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });

  it("remembers a search that ended in a click, not only one that reached the page", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");
    await userEvent.click(await screen.findByText(/marketing weekly/));

    // What somebody typed is what they will want back tomorrow; whether they
    // happened to find it on the first page does not change that.
    expect(readRecentSearches("usr_1")).toEqual(["product"]);
  });

  it("says how much of the archive it is not showing, and offers no page for it", async () => {
    results = response({ mentions: { total: 40, hits: response().mentions.hits } });
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");
    await screen.findByText(/marketing weekly/);

    // Two of forty-one drawn. "See all results" opened a page that could show
    // them; with the page gone, saying so and saying what to do about it beats
    // a button that goes nowhere.
    expect(screen.getByText(/Showing 2 of 41/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /See all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Search everything/ })).not.toBeInTheDocument();
  });

  it("says nothing matched, and what to try instead", async () => {
    results = NOTHING;
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    // It used to point at /search, which paid for an embedding and could find a
    // passage that meant this. With the page gone there is nowhere to send
    // somebody whose wording was wrong, so the advice has to be usable here.
    expect(await screen.findByText(/Nothing in your conversations/)).toBeInTheDocument();
    expect(screen.queryByText(/open it below/i)).not.toBeInTheDocument();
  });

  it("does not search the archive before there is anything to search for", () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    expect(searchQuery).not.toHaveBeenCalled();
  });

  it("searches once the typing settles, not once per keystroke", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    await waitFor(() => expect(searchQuery).toHaveBeenCalled());
    // Seven keystrokes must not be seven searches across every transcript.
    const terms = searchQuery.mock.calls.map((c) => (c[0] as { q: string }).q);
    expect(terms).not.toContain("produc");
  });

  it("asks only for the two groups it can draw", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "product");

    await waitFor(() => expect(searchQuery).toHaveBeenCalled());
    const args = searchQuery.mock.calls.at(-1)?.[0] as { groups?: string[] };
    expect(args.groups).toEqual(["meetings", "mentions"]);
  });

  it("searches for what a filter leaves behind, not for the filter", async () => {
    render(<SearchCommand open onOpenChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search"), "tag:q4 product");

    await waitFor(() => expect(searchQuery).toHaveBeenCalled());
    const args = searchQuery.mock.calls.at(-1)?.[0] as { q: string; tag?: string };
    expect(args.q).toBe("product");
    expect(args.tag).toBe("q4");
  });
});

describe("showing what is narrowed", () => {
  it("puts a chip up for each filter, so the narrowing is never invisible", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "tag:q4 stripe");

    expect(await screen.findByText("tag: q4")).toBeInTheDocument();
  });
});

describe("searching", () => {
  it("carries the filters into the request, not into a URL", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "tag:q4 stripe");

    // The filter is applied to the search this box runs. It used to be encoded
    // into /search?tag=q4&q=stripe and handed to a page.
    await waitFor(() =>
      expect(searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "stripe", tag: "q4" }),
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("completes a half-typed filter on Enter instead of searching for it", async () => {
    // `tag:q` submitted as free text returns nothing and looks like the
    // archive is empty.
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    const input = screen.getByLabelText("Search") as HTMLInputElement;
    await user.type(input, "tag:q");
    await user.keyboard("{Enter}");

    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("tag:q4 "));
  });

  it("opens a result on Enter once there is nothing left to complete", async () => {
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Search"), "stripe");
    await screen.findByText(/marketing weekly/);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/meetings/mtg_1"));
  });

  it("closes on Escape without searching", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<SearchCommand open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Search"), "stripe");
    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });
});
