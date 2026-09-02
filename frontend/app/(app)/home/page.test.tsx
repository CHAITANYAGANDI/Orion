import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, MeetingListQuery, Page, Project } from "@/lib/types";

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
/** The retry button is wired to this. */
const refetch = vi.hoisted(() => vi.fn());

let rows: MeetingResponse[];
let loading: boolean;
/** How many meetings exist at all, filed or not. Only the empty states ask. */
let workspaceTotal: number;

/* ---------------------------------------------------------------------------
 * The states the old mock could not express.
 *
 * It returned `{ data, isLoading }` and nothing else, which is exactly the
 * subset of RTK Query the page used -- so the mock agreed with the bug. A
 * failed request and an empty one were indistinguishable to both, and no test
 * could tell them apart either.
 * ------------------------------------------------------------------------ */

/** A refetch is in flight over whatever is cached. */
let fetching: boolean;
/** The request settled as rejected. */
let errored: boolean;
/** Nothing usable is cached -- `data` is undefined, not an empty page. */
let noData: boolean;
/** The one-row probe behind the empty states failed. */
let probeErrored: boolean;
/** The one-row probe has not answered yet. */
let probeLoading: boolean;

/*
 * The folders, which the empty state reads as well.
 *
 * "Everything is in a folder" is a claim about these, and production showed it
 * over a sidebar with none -- so the folder list is part of what decides that
 * screen now, and part of what these tests can move.
 */
let folderRows: Project[];
let foldersLoading: boolean;
let foldersErrored: boolean;

function aPage(content: MeetingResponse[], total = content.length): Page<MeetingResponse> {
  return { content, page: 0, size: 50, totalElements: total, totalPages: 1 };
}

/** An RTK Query result with every flag the page reads, kept mutually consistent. */
function result<T>(data: T | undefined, opts: {
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
} = {}) {
  const isLoading = opts.isLoading ?? false;
  const isFetching = opts.isFetching ?? isLoading;
  const isError = opts.isError ?? false;
  return {
    data,
    isLoading,
    isFetching,
    isError,
    // RTK sets exactly one of these. Success means settled and not rejected --
    // note it stays true during a background refetch that has stale data, which
    // is why `isFetching` has to be read separately.
    isSuccess: !isLoading && !isError && data !== undefined,
    isUninitialized: false,
    error: isError ? { status: 500, data: { message: "boom" } } : undefined,
    refetch,
  };
}

vi.mock("@/lib/api", () => ({
  // The per-meeting poll that a processing row runs underneath its socket
  // subscription. Home lists meetings; only the rows that are still being
  // processed reach for this, and none of these tests is about one.
  useGetMeetingQuery: () => ({ data: undefined }),
  useGetMeetingsQuery: (q: MeetingListQuery, options?: { skip?: boolean }) => {
    if (options?.skip) {
      return {
        data: undefined,
        isLoading: false,
        isFetching: false,
        isError: false,
        isSuccess: false,
        isUninitialized: true,
        error: undefined,
        refetch,
      };
    }
    // The one-row probe behind the empty state: is anything filed elsewhere, or
    // is this account new? It asks for a count, not for rows.
    if (q.size === 1) {
      if (probeErrored) return result<Page<MeetingResponse>>(undefined, { isError: true });
      if (probeLoading) return result<Page<MeetingResponse>>(undefined, { isLoading: true });
      return result(aPage([], workspaceTotal));
    }

    query.last = q;
    // Filtering happens in the query, so the mock returns what it was asked
    // for. Asserting on the request is the point: a client-side filter would
    // pass a test that fed it both kinds of row and hid one.
    if (loading) return result<Page<MeetingResponse>>(undefined, { isLoading: true });
    // An error keeps whatever was cached -- RTK does not throw the last good
    // page away -- so `noData` is what separates "failed with nothing" from
    // "failed over meetings already on screen".
    const data = noData ? undefined : aPage(rows);
    return result(data, { isFetching: fetching, isError: errored });
  },
  useGetProjectsQuery: () => {
    if (foldersLoading) return result<Project[]>(undefined, { isLoading: true });
    if (foldersErrored) return result<Project[]>(undefined, { isError: true });
    return result(folderRows);
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
  refetch.mockClear();
  loading = false;
  fetching = false;
  errored = false;
  noData = false;
  probeErrored = false;
  probeLoading = false;
  // One folder by default, so "everything is filed" is an explanation the rest
  // of the screen can support. The tests that remove it are the point.
  folderRows = [{ id: "prj_1", name: "Client ABC" } as Project];
  foldersLoading = false;
  foldersErrored = false;
  rows = [aMeeting()];
  workspaceTotal = rows.length;
  // The filters outlive a page now, so without this they would outlive a test
  // and the order the suite happened to run in would decide what Home opened
  // on. See lib/preference-store.ts.
  window.localStorage.clear();
  auth.sessionKey = "sess_1";
});

describe("the scope picker", () => {
  it("offers what is outside a folder and the whole workspace, in that order", async () => {
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /Recent Conversations/ }));
    const menu = screen.getByRole("menu");
    const options = within(menu).getAllByRole("menuitemradio");

    // Recent first, and Home opens on it -- but they are two decisions, and
    // they have not always agreed: there was a build where this list led with
    // Recent and the page opened on All. Ordering asserted here, default
    // asserted in "the scope Home opens on" below.
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

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(true);
  });

  it("asks the server for the whole workspace when All is chosen", async () => {
    render(<HomePage />);

    await choose("All Conversations");

    // Both options reach the server. All used to narrow the page in the
    // browser, and narrow it by nothing: the two ran through a function that
    // returned its argument.
    expect(query.last?.unfiled).toBe(false);
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

  it("does not treat the previous sign-in's choice as this one's", async () => {
    // The half of the production report that was a real defect rather than a
    // product choice: a stored value belonging to session 1, still reported as
    // ready under session 2, decided the first query of the new sign-in.
    const visit = render(<HomePage />);
    await choose("All Conversations");
    visit.unmount();

    auth.sessionKey = "sess_2";
    query.last = null;
    render(<HomePage />);

    // Read through the helper: TypeScript narrows `query.last` to `never` after
    // the assignment above, and the assertion is about what happens later.
    expect(lastQuery()?.unfiled).toBe(true);
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
    await choose("All Conversations");
    first.unmount();

    const second = render(<HomePage />);
    await choose("Recent Conversations");
    second.unmount();

    // Choosing the default is a choice. Were it treated as "no opinion", the
    // next visit would reinstate All and the picker would quietly undo what
    // somebody had just told it.
    render(<HomePage />);
    expect(query.last?.unfiled).toBe(true);
  });

  it("goes back to the defaults after a sign-out and sign-in", async () => {
    /*
     * Reported from production twice: signing out and back in landed on All
     * Conversations. Once because the previous session's stored value was still
     * being treated as ready under the new session (see lib/preferences.ts),
     * and once because the default itself was All.
     *
     * Both halves are pinned here: the choice below must not survive the
     * session change, and what replaces it must be Recent.
     */
    const visit = render(<HomePage />);
    await choose("All Conversations");
    expect(query.last?.unfiled).toBe(false);
    visit.unmount();

    // A new session is what signing out and back in produces — as the same
    // person or as somebody else.
    auth.sessionKey = "sess_2";
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(true);
  });

  it("asks the server once, with the filters it restored", async () => {
    const visit = render(<HomePage />);
    await choose("All Conversations");
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    // Storage cannot be read while rendering, so the first render necessarily
    // holds the defaults. Asking then would fetch the narrowed list and fetch
    // it again whole -- two requests and a list that changes under the reader.
    // The query waits instead, and the one request it makes carries the
    // restored scope rather than the default.
    expect(lastQuery()?.unfiled).toBe(false);
  });
});

/**
 * Where Home starts, and the thing that makes starting there safe.
 *
 * <h2>The bug this default once caused</h2>
 *
 * <p>Recent is `unfiled=true` on the wire — conversations that were never put
 * in a folder — so an account that had filed everything opened Home to a list
 * with nothing in it, and the page said "No conversations" and offered to help
 * with a first recording. The archive-lost screen, over a full archive, reached
 * by doing nothing.
 *
 * <p>The default was only the road there. What made it unrecoverable is that an
 * empty list never said <em>which filter had emptied it</em> — the same screen
 * appeared whether the workspace was empty or merely tidy. Home tells those
 * apart now: an empty Recent asks the server whether the workspace holds
 * anything at all, and the answers get opposite screens.
 *
 * <p>So the default is Recent again, and these are what keep it honest. The
 * pair that matters most is the last two: on the default scope, an empty list
 * over a workspace with meetings must say they are filed, and an empty list
 * over an empty workspace must not.
 */
describe("the scope Home opens on", () => {
  it("defaults a fresh visit to Recent Conversations", () => {
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
  });

  it("sends unfiled=true on the very first query", () => {
    render(<HomePage />);

    // The wire, not the label. A label that reads Recent over a query that
    // still says unfiled=false is the version of this that looks right.
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("shows what is on the default list rather than hiding it behind a switch", () => {
    rows = [aMeeting({ id: "mtg_unfiled", title: "Not filed anywhere" })];
    workspaceTotal = 40;

    render(<HomePage />);

    expect(screen.getByText("Not filed anywhere")).toBeInTheDocument();
  });

  it("ignores a legacy home.scope left by the old build", () => {
    /*
     * The migration, and the reason the key is versioned.
     *
     * Written the way the old build wrote it, under the same session stamp, so
     * this is a real upgrade rather than a simulated one. Under v1 the picker
     * wrote on every interaction, so a stored value could not be told apart
     * from never having chosen at all -- and honouring it would let a build
     * from two defaults ago decide where this one opens.
     */
    window.localStorage.setItem(
      "reverie.prefs",
      JSON.stringify({ session: "sess_1", values: { "home.scope": "all" } }),
    );

    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("does not drift to All when you leave for a meeting and return", async () => {
    // Home is a page people leave and return to all day, and the default has
    // moved twice. Whichever way it points, it has to still point there on the
    // way back.
    const visit = render(<HomePage />);
    expect(lastQuery()?.unfiled).toBe(true);
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("still sends unfiled=false when All is chosen deliberately", async () => {
    // The whole workspace is a click away and has to stay one, or the default
    // has traded one broken list for a missing one.
    render(<HomePage />);

    await choose("All Conversations");

    expect(lastQuery()?.unfiled).toBe(false);
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

  it("returns to Recent for a new session, discarding an explicit All", async () => {
    // Reported from production: signing out and back in landed on All
    // Conversations. Both halves of that are pinned here -- the previous
    // sign-in's choice is discarded, and what replaces it is the default.
    const visit = render(<HomePage />);
    await choose("All Conversations");
    expect(lastQuery()?.unfiled).toBe(false);
    visit.unmount();

    // Signing out and back in -- as the same person or somebody else.
    auth.sessionKey = "sess_2";
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("offers a first recording, not a folder hint, to an account with nothing in it", () => {
    // The two empty states mean opposite things and want opposite screens. The
    // probe is what tells them apart: nothing in the workspace at all, so the
    // folder screen here would tell a new account its meetings are filed
    // somewhere and hand it a button to another empty list.
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });

  it("will not say the meetings are filed when there is no folder to file them in", () => {
    /*
     * THE production screen, as an assertion: "Everything is in a folder" over
     * a sidebar with no folders in it.
     *
     * Those two cannot both be true -- with no folders, "outside your folders"
     * and "everything" are the same list -- and Home had every fact needed to
     * know that and said it anyway. Which one of the two answers is wrong is
     * not knowable from here, so the screen claims neither.
     */
    rows = [];
    workspaceTotal = 40;
    folderRows = [];

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't show your conversations/i)).toBeInTheDocument();
  });

  it("offers a retry and the whole list when it cannot explain itself", async () => {
    rows = [];
    workspaceTotal = 40;
    folderRows = [];

    render(<HomePage />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show all conversations" })).toBeInTheDocument();
  });

  it("says nothing at all while the folder list is still on its way", () => {
    /*
     * Every screen this component can draw for an empty Recent makes a claim
     * about folders -- that the meetings are in one, that there is none to be
     * in, or that some may be. All three need the folder list, so until it
     * arrives the honest output is nothing: a sentence that turns out to be
     * wrong is worse than a blank half-second.
     */
    rows = [];
    workspaceTotal = 40;
    foldersLoading = true;

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't show your conversations/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing outside your folders")).not.toBeInTheDocument();
    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
  });

  it("does not claim the meetings are filed when the folder list failed", () => {
    // A failed folder request proves nothing about where the meetings are. The
    // screen falls back to the one thing still certainly true: this list leaves
    // filed conversations out, and the wider list is one click away.
    rows = [];
    workspaceTotal = 40;
    foldersErrored = true;

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing outside your folders")).toBeInTheDocument();
  });

  it("says the meetings are filed rather than that there are none", () => {
    /*
     * THE reason the default can be Recent at all, and the exact screen that
     * made it a bug last time.
     *
     * An account that has filed everything opens Home to an empty Recent. The
     * old build called that "No conversations" and offered a first recording,
     * which is a lie told to somebody with forty meetings. It has to name the
     * filter that emptied the list, and offer the way past it.
     */
    rows = [];
    workspaceTotal = 40;

    render(<HomePage />);

    expect(screen.getByText("Everything is in a folder")).toBeInTheDocument();
    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all conversations" })).toBeInTheDocument();
  });
});

/**
 * Never tell somebody their archive is empty because a request failed.
 *
 * <h2>The bug</h2>
 *
 * <p>Home showed "No conversations — Record / Import" to accounts with hundreds
 * of meetings, over a picker still reading "All Conversations" and "Any time".
 *
 * <p>It decided with `groupByDay(data?.content ?? [])` and
 * `groups.length === 0`, guarded only by `isLoading`. The `?? []` is the whole
 * fault: it reads *no answer* as *the answer is none*. A failed request, a
 * refetch in flight, and a genuinely empty workspace all became the same screen
 * — and `isLoading` does not cover the first two, because it is true only for
 * the very first load of a cache entry. A refetch sets `isFetching`; an error
 * sets neither.
 *
 * <p>The rule these pin: the empty screen is a *claim about the account*, and
 * only a settled, successful, genuinely empty response is allowed to make it.
 */
describe("what Home shows when the request does not simply succeed", () => {
  const EMPTY = "No conversations";
  const LOAD_ERROR = /couldn.t load your conversations/i;

  it("does not claim an empty account when the request failed and left no data", () => {
    // The production symptom, at its root: data undefined, isLoading false.
    errored = true;
    noData = true;

    render(<HomePage />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(screen.getByText(LOAD_ERROR)).toBeInTheDocument();
  });

  it("offers a retry on a failed request, wired to refetch", async () => {
    errored = true;
    noData = true;

    render(<HomePage />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("announces the failure to assistive technology", () => {
    errored = true;
    noData = true;

    render(<HomePage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps backend detail off the screen", () => {
    // The mock's error carries `status: 500` and `message: "boom"`. Neither is
    // any use to a reader, and both describe the shape of the backend on a page
    // anybody signed in can reach.
    errored = true;
    noData = true;

    render(<HomePage />);

    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/boom/i)).not.toBeInTheDocument();
  });

  it("does not claim an empty account when there is simply no data yet", () => {
    /*
     * The exact `?? []` bug, with no error to mask it. Every other test here
     * that has no data also has an error, and the error branch answers first --
     * so mutating the rule to treat undefined as empty left all of them passing.
     * Measured, not assumed. See lib/home-list-state.test.ts.
     */
    noData = true;

    render(<HomePage />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("shows the skeleton before the first response, not an empty message", () => {
    loading = true;

    const { container } = render(<HomePage />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(screen.queryByText(LOAD_ERROR)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("does not confirm an empty account while a refetch over an empty page is in flight", () => {
    // The cached page says zero, but a request that may replace it is running.
    // Announcing an empty account now is a guess that is about to be checked.
    rows = [];
    workspaceTotal = 0;
    fetching = true;

    render(<HomePage />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("keeps meetings on screen during a background refetch", () => {
    // Replacing a list somebody is reading with a skeleton, because a refresh
    // they did not ask for is running, is the other half of this bug.
    rows = [aMeeting({ id: "mtg_keep", title: "Still here" })];
    fetching = true;

    render(<HomePage />);

    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("keeps meetings on screen when a background refetch fails", () => {
    // Known-good rows beat a failed refresh. Throwing away the good copy
    // because the new one did not arrive is strictly worse than showing it.
    rows = [aMeeting({ id: "mtg_keep", title: "Still here" })];
    errored = true;

    render(<HomePage />);

    expect(screen.getByText("Still here")).toBeInTheDocument();
    expect(screen.queryByText(LOAD_ERROR)).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("allows the empty screen once the request settles successfully with nothing", () => {
    // The fix must not make the empty state unreachable -- that would trade a
    // false negative for a permanent skeleton on a genuinely new account.
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });

  it("shows meetings on a successful non-empty response", () => {
    rows = [aMeeting({ id: "mtg_a", title: "Tuesday design review" })];

    render(<HomePage />);

    expect(screen.getByText("Tuesday design review")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("says nothing at all while the folder probe is still in flight", async () => {
    // "Everything is in a folder" and "you have nothing" are opposite claims
    // and the probe is what decides between them. A sentence that turns out to
    // be wrong is worse than a blank half-second.
    rows = [];
    probeLoading = true;

    render(<HomePage />);
    await choose("Recent Conversations");

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("does not treat a failed folder probe as proof the account is empty", async () => {
    /*
     * The same rule, one layer down. The probe answers "is anything filed
     * elsewhere?", and reading a failed probe as zero produces the
     * first-recording screen for somebody whose meetings are all in folders.
     */
    rows = [];
    probeErrored = true;

    render(<HomePage />);
    await choose("Recent Conversations");

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing outside your folders")).toBeInTheDocument();
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

/**
 * The label has to mean what the filter does.
 *
 * <p>This option was called "Recent Conversations" and sends `unfiled=true` --
 * a folder filter under a name about time. Both options are newest-first and
 * both sit inside the same date window, so "Recent" described nothing the list
 * actually did, and the property it did have was invisible.
 *
 * <p>It is most of why the empty state read as a fault: somebody shown
 * "Everything is in a folder" under a list named after recency has been handed
 * two unrelated sentences and no way to connect them.
 */
/**
 * The label says "Recent" and the filter is about folders, so the hint is the
 * only thing that explains the list.
 *
 * <p>That is a deliberate choice rather than an oversight -- "Recent" is the
 * product's word for this list -- and it puts the whole weight of the
 * explanation on one line of small text. These hold that line in place. Without
 * it, a meeting recorded ten minutes ago inside a folder is simply absent from
 * a list called Recent, and the "Everything is in a folder" empty state behind
 * it arrives with nothing to connect it to.
 */
describe("the scope picker explains what it filters on", () => {
  it("carries the folder meaning in the hint, since the label does not", async () => {
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /Recent Conversations/ }));
    const recent = screen.getAllByRole("menuitemradio")[0];

    expect(recent).toHaveTextContent(/Recent Conversations/i);
    expect(recent).toHaveTextContent(/outside your folders/i);
  });

  it("pairs it with a hint for All, so the two read as two lists", async () => {
    // "everything outside your folders" / "everything in this workspace".
    // Said that way round they describe two lists, rather than one list and
    // one property a meeting either has or does not.
    render(<HomePage />);

    await userEvent.click(screen.getByRole("button", { name: /Recent Conversations/ }));

    expect(screen.getAllByRole("menuitemradio")[1]).toHaveTextContent(/in this workspace/i);
  });

  it("sends unfiled=true under that name, so the label and the wire agree", async () => {
    render(<HomePage />);
    await choose("Recent Conversations");

    expect(query.last?.unfiled).toBe(true);
  });
});

/**
 * A sign-in change under a page that is already open.
 *
 * <p>The other Home tests here start a fresh render for each session, which is
 * what a full page load does. Production does not always do that: signing out
 * and back in are both client navigations, so Home can be re-rendered under a
 * new `sessionKey` without ever unmounting -- and that is the render in which
 * the previous session's remembered scope was still being reported as ready.
 */
describe("when the sign-in changes under an open page", () => {
  /** Read through a call so TypeScript does not narrow it to the null we just set. */
  const lastUnfiled = () => query.last?.unfiled;

  it("never asks for the previous session's scope", async () => {
    // A choice made under one sign-in deciding the first query of the next is
    // the defect, whichever way the choice pointed. Here it is All, because
    // that is what production reported: signing out and back in landed on All
    // Conversations rather than on the default.
    const view = render(<HomePage />);
    await choose("All Conversations");
    expect(query.last?.unfiled).toBe(false);

    const asked: Array<boolean | undefined> = [];
    query.last = null;
    auth.sessionKey = "sess_2";
    await act(async () => {
      view.rerender(<HomePage />);
    });
    asked.push(lastUnfiled());

    // Whatever it asked for, it was not the previous sign-in's filter.
    expect(asked).not.toContain(false);
  });

  it("starts the new sign-in on Recent Conversations", async () => {
    const view = render(<HomePage />);
    await choose("All Conversations");

    auth.sessionKey = "sess_2";
    await act(async () => {
      view.rerender(<HomePage />);
    });

    expect(screen.getByRole("button", { name: /Recent Conversations/ })).toBeInTheDocument();
    expect(query.last?.unfiled).toBe(true);
  });

  it("keeps an explicit choice while the sign-in does not change", async () => {
    const view = render(<HomePage />);
    await choose("Recent Conversations");

    await act(async () => {
      view.rerender(<HomePage />);
    });

    expect(query.last?.unfiled).toBe(true);
  });
});
