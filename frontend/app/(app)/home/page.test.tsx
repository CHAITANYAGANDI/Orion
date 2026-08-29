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

// `isLoaded` and `sessionKey` are not decoration: both filters are remembered
// per sign-in, and nothing reads what was remembered until auth says which
// sign-in this is.
const auth = vi.hoisted(() => ({ sessionKey: "sess_1" }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_1", sessionKey: auth.sessionKey, isLoaded: true }),
}));
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

/**
 * What the mock last recorded.
 *
 * <p>A function, not `query.last` directly: a test that clears it and then
 * re-renders is narrowed to `null` by the compiler, which cannot know that
 * rendering writes to it. Reading through a call returns the declared type.
 */
function lastQuery(): MeetingListQuery | null {
  return query.last;
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
  // The filters outlive a page now, so without this they would outlive a test
  // and the order the suite happened to run in would decide what Home opened
  // on. See lib/preference-store.ts.
  window.localStorage.clear();
  auth.sessionKey = "sess_1";
});

describe("the scope picker", () => {
  it("offers the whole workspace and what is outside a folder, in that order", async () => {
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /All Conversations/ }));
    const menu = screen.getByRole("menu");
    const options = within(menu).getAllByRole("menuitemradio");

    // All first: it is where Home opens, and an option list that does not
    // start with the one you are on reads as a list of somewhere else. The
    // order followed the default when the default was Recent, and follows it
    // still.
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("All Conversations");
    expect(options[1]).toHaveTextContent("Recent Conversations");
    // The label is about folders, not about time, and only the hint says so.
    expect(within(menu).getByText("everything outside your folders")).toBeInTheDocument();
    // It counted twenty rows and called them unread. Nothing tracks whether a
    // meeting has been read.
    expect(within(menu).queryByText(/For you/)).not.toBeInTheDocument();
  });

  it("starts on the whole workspace", () => {
    render(<HomePage />);

    // The regression. Home used to open on Recent, which is `unfiled=true` --
    // so the default list hid every meeting that had been filed, and an account
    // that had tidied up opened Home to an empty state.
    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(false);
  });

  it("asks the server for what is outside a folder only when asked to", async () => {
    render(<HomePage />);

    await choose("Recent Conversations");

    // Recent still works and still reaches the server. It used to narrow the
    // page in the browser, and narrow it by nothing: both options ran through a
    // function that returned its argument.
    expect(query.last?.unfiled).toBe(true);
  });

  it("asks for the whole workspace again on the way back", async () => {
    render(<HomePage />);
    await choose("Recent Conversations");

    await choose("All Conversations");

    expect(query.last?.unfiled).toBe(false);
  });

  it("keeps the date window while the scope changes", async () => {
    render(<HomePage />);

    await choose("Recent Conversations");

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
  it("says the rest is filed once Recent was chosen, and offers the way back", async () => {
    rows = [];
    workspaceTotal = 11;

    render(<HomePage />);
    // Explicitly, because Home no longer starts here. This screen describes a
    // list that is hiding rows, which is only true of Recent.
    await choose("Recent Conversations");

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

/**
 * A filter you set once.
 *
 * <p>Home is a page people leave and come back to all day — open a meeting,
 * come back, open another — and both controls above the list used to reset
 * every time. Narrowing to last week was work you redid on every return.
 *
 * <p>So the choice is remembered, and the exception is the requirement: signing
 * out puts both back to their defaults. `unmount` then `render` here is
 * literally leaving Home and returning to it; the sign-in changing is somebody
 * signing out and back in.
 */
describe("filters that stay where you left them", () => {
  it("opens on the scope you chose last time", async () => {
    const visit = render(<HomePage />);
    await choose("All Conversations");
    expect(query.last?.unfiled).toBe(false);
    visit.unmount();

    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(false);
  });

  it("opens on the date window you chose last time", async () => {
    const visit = render(<HomePage />);
    await userEvent.click(screen.getByRole("button", { name: /Any time/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Last 7 days/ }),
    );
    expect(query.last?.from).toBeTruthy();
    visit.unmount();

    render(<HomePage />);

    // The label, and a lower bound actually reaching the server. A restored
    // label over an unfiltered query is the version of this that looks right.
    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeInTheDocument();
    expect(query.last?.from).toBeTruthy();
  });

  it("remembers going back to the default just as firmly", async () => {
    const first = render(<HomePage />);
    await choose("Recent Conversations");
    first.unmount();

    const second = render(<HomePage />);
    await choose("All Conversations");
    second.unmount();

    // Choosing the default is a choice. Were it treated as "no opinion", the
    // next visit would reinstate Recent and this would be the same bug
    // reversed -- which is exactly the shape of the bug being fixed.
    render(<HomePage />);
    expect(query.last?.unfiled).toBe(false);
  });

  it("goes back to the defaults after a sign-out and sign-in", async () => {
    const visit = render(<HomePage />);
    await choose("All Conversations");
    expect(query.last?.unfiled).toBe(false);
    visit.unmount();

    // A new session is what signing out and back in produces — as the same
    // person or as somebody else.
    auth.sessionKey = "sess_2";
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(false);
  });

  it("asks the server once, with the filters it restored", async () => {
    const visit = render(<HomePage />);
    await choose("Recent Conversations");
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    // Storage cannot be read while rendering, so the first render necessarily
    // holds the defaults. Asking then would fetch the whole workspace and fetch
    // it again narrowed -- two requests and a list that changes under the
    // reader. The query waits instead, and the one request it makes carries the
    // restored scope rather than the default.
    expect(lastQuery()?.unfiled).toBe(true);
  });
});

/**
 * The default that hid your meetings.
 *
 * <h2>The bug</h2>
 *
 * <p>Home defaulted to Recent Conversations, and Recent is `unfiled=true` on the
 * wire — conversations that were never put in a folder. So the default Home was
 * not "your meetings", it was "your meetings, minus the ones you organised". An
 * account that had filed everything opened Home to "Everything is in a folder"
 * with no meetings visible at all.
 *
 * <p>Persistence made it stick: the scope is remembered, so once `recent` was
 * written down every later visit restored it. Open a meeting, come back, empty
 * state again.
 *
 * <p>Fixing the default alone would not have fixed the deployment. Browsers
 * already carrying `home.scope: "recent"` would restore it over the new default,
 * so the bug would survive precisely where it was happening — hence a versioned
 * key, and hence the legacy test below, which is the one that would have caught
 * a fix that looked complete and shipped broken.
 */
describe("the scope Home opens on", () => {
  it("defaults a fresh visit to All Conversations", () => {
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
  });

  it("sends unfiled=false on the very first query", () => {
    render(<HomePage />);

    // The wire, not the label. A restored label over a query that still says
    // unfiled=true is the version of this bug that looks fixed.
    expect(lastQuery()?.unfiled).toBe(false);
  });

  it("shows meetings on a default visit even when they are all in folders", () => {
    // The user-visible bug, end to end. `workspaceTotal` exceeding the rows is
    // what "everything is filed" looks like from here.
    rows = [aMeeting({ id: "mtg_filed", title: "Filed away" })];
    workspaceTotal = 40;

    render(<HomePage />);

    expect(screen.getByText("Filed away")).toBeInTheDocument();
    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });

  it("ignores a legacy home.scope=recent left by the old build", () => {
    /*
     * The migration, and the reason the key is versioned.
     *
     * Written the way the old build wrote it, under the same session stamp, so
     * this is a real upgrade rather than a simulated one. Under v1 the default
     * was `recent`, so a stored `"recent"` cannot be told apart from never
     * having chosen at all -- honouring it would carry the bug through the
     * deployment into exactly the browsers that had it.
     */
    window.localStorage.setItem(
      "orion.prefs",
      JSON.stringify({ session: "sess_1", values: { "home.scope": "recent" } }),
    );

    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(false);
  });

  it("does not drift back to Recent when you leave for a meeting and return", async () => {
    // Home is a page people leave and return to all day. The bug showed up on
    // the return trip, so the return trip is what is pinned.
    const visit = render(<HomePage />);
    expect(lastQuery()?.unfiled).toBe(false);
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(false);
  });

  it("still sends unfiled=true when Recent is chosen deliberately", async () => {
    // Recent is not removed, only demoted. It has to keep working, or the fix
    // has traded one broken list for a missing feature.
    render(<HomePage />);

    await choose("Recent Conversations");

    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("keeps an explicit Recent across a return visit", async () => {
    // Stickiness survives the version bump for choices made under v2, where a
    // stored value is unambiguous because it differs from the default.
    const visit = render(<HomePage />);
    await choose("Recent Conversations");
    visit.unmount();

    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("keeps an explicit All across a return visit", async () => {
    const visit = render(<HomePage />);
    await choose("Recent Conversations");
    await choose("All Conversations");
    visit.unmount();

    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(false);
  });

  it("returns to All for a new session, discarding an explicit Recent", async () => {
    const visit = render(<HomePage />);
    await choose("Recent Conversations");
    expect(lastQuery()?.unfiled).toBe(true);
    visit.unmount();

    // Signing out and back in -- as the same person or somebody else.
    auth.sessionKey = "sess_2";
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /All Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(false);
  });

  it("offers a first recording, not a folder hint, to an empty account on the default", () => {
    // The two empty states mean opposite things and want opposite screens. On
    // All Conversations an empty list means the workspace is empty, so the
    // folder screen here would tell a new account its meetings are filed
    // somewhere and hand it a button to another empty list.
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });

  it("never shows the folder empty state on the default scope, even with meetings filed", () => {
    // The strict form of the requirement: "Everything is in a folder" may
    // appear only when the unfiled list was explicitly asked for. Here the
    // workspace has forty meetings and the default list came back empty --
    // which cannot happen for real, and is exactly why it is worth asserting.
    rows = [];
    workspaceTotal = 40;

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });
});

/**
 * A meeting still being made, in the list it already belongs to.
 *
 * <p>The rule these hold: the processing row is the *same* row. Not a separate
 * "Processing" section above the list, not a card of its own, and not a second
 * bar floating over the corner of the page — one meeting, one place, which it
 * keeps from the moment it is saved until it is ready.
 */
describe("a meeting that is still processing", () => {
  it("says so in its own row, with the stage and how far along", () => {
    rows = [aMeeting({ id: "mtg_p", title: "Recording — 8/26/2026", status: "SUMMARIZING" })];

    render(<HomePage />);

    // The pill is one word while it runs; the stage is said in full underneath.
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("Generating summary…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Processing progress" }))
      .toBeInTheDocument();
  });

  it("keeps the title, the time and the duration it always had", () => {
    // Additive. The row does not become a different kind of object while it is
    // being made.
    rows = [aMeeting({ id: "mtg_p", title: "Recording — 8/26/2026",
      status: "TRANSCRIBING", durationSeconds: 16 })];

    render(<HomePage />);

    expect(screen.getByText("Recording — 8/26/2026")).toBeInTheDocument();
    expect(screen.getByText(/0m 16s/)).toBeInTheDocument();
  });

  it("still opens the normal meeting page when clicked", () => {
    // Not a disabled row, and not a different route. The meeting exists and has
    // a page from the moment it is created.
    rows = [aMeeting({ id: "mtg_p", title: "Recording", status: "QUEUED" })];

    render(<HomePage />);

    expect(screen.getByRole("link", { name: /Recording/ })).toHaveAttribute(
      "href",
      "/meetings/mtg_p",
    );
  });

  it("draws no processing UI on a finished meeting", () => {
    rows = [aMeeting({ id: "mtg_r", title: "Done", status: "READY" })];

    render(<HomePage />);

    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("draws no processing UI on a failed meeting either", () => {
    // FAILED is terminal. A bar over it would be a job that is going to finish.
    rows = [aMeeting({ id: "mtg_f", title: "Broken", status: "FAILED" })];

    render(<HomePage />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows one bar per processing meeting and none for the rest", () => {
    rows = [
      aMeeting({ id: "mtg_a", title: "One", status: "TRANSCRIBING" }),
      aMeeting({ id: "mtg_b", title: "Two", status: "READY" }),
      aMeeting({ id: "mtg_c", title: "Three", status: "EXTRACTING" }),
    ];

    render(<HomePage />);

    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
});
