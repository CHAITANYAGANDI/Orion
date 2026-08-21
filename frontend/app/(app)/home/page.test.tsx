import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, MeetingListQuery, Page } from "@/lib/types";

/**
 * Home, and the picker above the list.
 *
 * <p>It had three options and no effect. "For you" took the twenty newest and
 * described them as unread, which nothing in the product tracks; "My
 * Conversations" and "All Conversations" returned identical rows, because one
 * account per workspace means every meeting is yours. Two of the three were
 * indistinguishable and the third was a lie about a number.
 *
 * <p>The distinction it draws now is one that exists: a recording or an import
 * started inside a folder is filed there, so "everything in the workspace" and
 * "what was never filed" are different lists.
 *
 * <p>What is pinned here is mostly that the filter reaches the server. Applied
 * over the fifty rows that came back, "conversations outside a folder" would be
 * answered with whichever of the fifty newest happened to be outside one — right
 * until somebody had more than fifty meetings, which is the version of this bug
 * that is invisible in development.
 */
const query = vi.hoisted(() => ({ last: null as MeetingListQuery | null }));
let rows: MeetingResponse[];
let loading: boolean;
/** How many meetings exist at all, filed or not. Only the empty states ask. */
let workspaceTotal: number;

function aPage(content: MeetingResponse[], total = content.length): Page<MeetingResponse> {
  return { content, page: 0, size: 50, totalElements: total, totalPages: 1 };
}

vi.mock("@/lib/api", () => ({
  useGetMeetingsQuery: (q: MeetingListQuery, options?: { skip?: boolean }) => {
    if (options?.skip) return { data: undefined, isLoading: false, isUninitialized: true };
    // The one-row probe behind the empty state: is anything filed elsewhere, or
    // is this account new? It asks for a count, not for rows.
    if (q.size === 1) return { data: aPage([], workspaceTotal), isLoading: false };

    query.last = q;
    // Filtering happens in the query, so the mock returns what it was asked
    // for. Asserting on the request is the point: a client-side filter would
    // pass a test that fed it both kinds of row and hid one.
    return { data: loading ? undefined : aPage(rows), isLoading: loading };
  },
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ userId: "usr_1" }) }));
vi.mock("@/components/side-pane", () => ({ SidePane: () => null }));
vi.mock("@/components/home-chat-panel", () => ({ HomeChatPanel: () => null }));
vi.mock("@/components/action-items-panel", () => ({ ActionItemsPanel: () => null }));

import HomePage from "@/app/(app)/home/page";

function aMeeting(overrides: Partial<MeetingResponse> = {}): MeetingResponse {
  return {
    id: "mtg_1",
    title: "Tuesday design review",
    status: "READY",
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Open the picker and choose a row by its label. */
async function choose(label: string) {
  await userEvent.click(screen.getByRole("button", { name: /Conversations/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(label) }));
}

beforeEach(() => {
  query.last = null;
  loading = false;
  rows = [aMeeting()];
  workspaceTotal = rows.length;
});

describe("the scope picker", () => {
  it("offers what is outside a folder and the whole workspace, in that order", async () => {
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /Recent Conversations/ }));
    const menu = screen.getByRole("menu");
    const options = within(menu).getAllByRole("menuitemradio");

    // Recent first: it is where Home opens, and an option list that does not
    // start with the one you are on reads as a list of somewhere else.
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Recent Conversations");
    expect(options[1]).toHaveTextContent("All Conversations");
    // The label is about folders, not about time, and only the hint says so.
    expect(within(menu).getByText("everything outside your folders")).toBeInTheDocument();
    // It counted twenty rows and called them unread. Nothing tracks whether a
    // meeting has been read.
    expect(within(menu).queryByText(/For you/)).not.toBeInTheDocument();
  });

  it("starts on what has not been filed", () => {
    render(<HomePage />);

    // Home is the list of what was not put somewhere else. The count on it is
    // therefore not the count in the workspace, which is the one thing about
    // this default anybody is likely to report.
    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(true);
  });

  it("asks the server for the whole workspace", async () => {
    render(<HomePage />);

    await choose("All Conversations");

    // The whole of the fix. This used to narrow the page in the browser, and
    // narrow it by nothing: both options ran through a function that returned
    // its argument.
    expect(query.last?.unfiled).toBe(false);
  });

  it("asks for the ones outside a folder again on the way back", async () => {
    render(<HomePage />);
    await choose("All Conversations");

    await choose("Recent Conversations");

    expect(query.last?.unfiled).toBe(true);
  });

  it("keeps the date window while the scope changes", async () => {
    render(<HomePage />);

    await choose("All Conversations");

    // Two filters over one list. Losing one when the other moves is the bug
    // that follows from rebuilding the query object per control.
    expect(query.last?.size).toBe(50);
    expect(query.last?.page).toBe(0);
  });
});

describe("the list", () => {
  it("shows every row it was given", () => {
    rows = Array.from({ length: 25 }, (_, i) => aMeeting({ id: `mtg_${i}`, title: `Meeting ${i}` }));

    render(<HomePage />);

    // "For you" cut the list at twenty. Nothing said so, so the twenty-first
    // meeting of the day was simply absent.
    expect(screen.getByText("Meeting 24")).toBeInTheDocument();
  });
});

describe("when there is nothing to show", () => {
  it("says the rest is filed, and offers the way back", async () => {
    rows = [];
    workspaceTotal = 11;

    render(<HomePage />);

    // Without this the page offers Record and Import to somebody with a
    // hundred meetings, which reads as an archive that lost them.
    expect(screen.getByText("Everything is in a folder")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all conversations" }));
    expect(query.last?.unfiled).toBe(false);
  });

  it("offers a first recording to an account with nothing in it", () => {
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    // The same empty list, on the same default scope, meaning the opposite
    // thing. Home opens here, so this is the first screen of a new account:
    // answering it with "everything is in a folder" and a button to another
    // empty list would be the worst possible first impression.
    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });

  it("still blames the date window first, since that is the likelier cause", async () => {
    rows = [];

    render(<HomePage />);
    await userEvent.click(screen.getByRole("button", { name: /Any time/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Today/ }),
    );

    expect(screen.getByText(/Nothing from Today/)).toBeInTheDocument();
  });

  it("points a genuinely empty account at the two ways to start", () => {
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Record/ })).toHaveAttribute(
      "href",
      "/record?r=%2Fhome",
    );
  });
});
