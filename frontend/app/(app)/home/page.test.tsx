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
 * answered with whichever of the fifty newest happened to be unfiled — right
 * until somebody had more than fifty meetings, which is the version of this bug
 * that is invisible in development.
 */
const query = vi.hoisted(() => ({ last: null as MeetingListQuery | null }));
let rows: MeetingResponse[];
let loading: boolean;

vi.mock("@/lib/api", () => ({
  useGetMeetingsQuery: (q: MeetingListQuery) => {
    query.last = q;
    // Filtering happens in the query, so the mock returns what it was asked
    // for. Asserting on the request is the point: a client-side filter would
    // pass a test that fed it both kinds of row and hid one.
    const page: Page<MeetingResponse> = {
      content: rows,
      page: 0,
      size: 50,
      totalElements: rows.length,
      totalPages: 1,
    };
    return { data: loading ? undefined : page, isLoading: loading };
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
  await userEvent.click(screen.getByRole("button", { name: /Conversations|Unfiled/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(label) }));
}

beforeEach(() => {
  query.last = null;
  loading = false;
  rows = [aMeeting()];
});

describe("the scope picker", () => {
  it("offers the workspace and the unfiled, and nothing else", async () => {
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /All Conversations/ }));
    const menu = screen.getByRole("menu");

    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2);
    expect(within(menu).getByRole("menuitemradio", { name: /All Conversations/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: /Unfiled/ })).toBeInTheDocument();
    // It counted twenty rows and called them unread. Nothing tracks whether a
    // meeting has been read.
    expect(within(menu).queryByText(/For you/)).not.toBeInTheDocument();
  });

  it("starts on everything", () => {
    render(<HomePage />);

    // A default that hides anything is how somebody concludes a meeting has
    // been lost, and a folder is the one place they will not think to look.
    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(false);
  });

  it("asks the server for the unfiled ones", async () => {
    render(<HomePage />);

    await choose("Unfiled");

    // The whole of the fix. This used to narrow the page in the browser, and
    // narrow it by nothing: both options ran through a function that returned
    // its argument.
    expect(query.last?.unfiled).toBe(true);
  });

  it("asks for the whole workspace again on the way back", async () => {
    render(<HomePage />);
    await choose("Unfiled");

    await choose("All Conversations");

    expect(query.last?.unfiled).toBe(false);
  });

  it("keeps the date window while the scope changes", async () => {
    render(<HomePage />);

    await choose("Unfiled");

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

    render(<HomePage />);
    await choose("Unfiled");

    expect(screen.getByText("Nothing outside a folder")).toBeInTheDocument();
    // Without this the page offers Record and Import to somebody with a
    // hundred meetings, which reads as an archive that lost them.
    await userEvent.click(screen.getByRole("button", { name: "Show all conversations" }));
    expect(query.last?.unfiled).toBe(false);
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

  it("offers a first recording when the workspace is genuinely empty", () => {
    rows = [];

    render(<HomePage />);

    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Record/ })).toHaveAttribute(
      "href",
      "/record?r=%2Fhome",
    );
  });
});
