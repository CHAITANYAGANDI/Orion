import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, MeetingListQuery, Page, Project } from "@/lib/types";

/**
 * Now — the greeting, the list, and the screens an empty list can be.
 *
 * <h2>What left this file, and what it left behind</h2>
 *
 * <p>There was a scope picker above the list with two options: <i>Recent
 * Conversations</i> (`unfiled=true` — everything outside your folders) and
 * <i>All Conversations</i> (everything in the workspace). It is gone, and
 * <i>All</i> is a page now: **Library**, in the band. Roughly a third of the
 * tests below used to drive that control.
 *
 * <p>None of the rules they held has been dropped. Each was one of three
 * things, and each has gone somewhere:
 *
 * <ul>
 *   <li><b>"the wire says unfiled"</b> — still asserted, now unconditionally.
 *       A label reading Recent over a query that says otherwise is still the
 *       version of this that looks right and is wrong.</li>
 *   <li><b>"the choice survives a visit and not a sign-in"</b> — re-asked of
 *       the date window, which is the other preference on this page and goes
 *       through the identical `useStickyPreference` machinery. The production
 *       defect was a stored value from session 1 being reported as ready under
 *       session 2; that is a property of the store, not of the scope.</li>
 *   <li><b>"an empty Recent must say which filter emptied it"</b> — unchanged
 *       and, if anything, more load-bearing: there is no picker to notice any
 *       more, so the label under the heading and the empty screens are the
 *       whole of the explanation.</li>
 * </ul>
 *
 * <p>What can no longer be tested here is what happens when All is chosen,
 * because there is no All. It is `app/(app)/library/page.test.tsx`, which pins
 * the thing that matters about it: that Library asks for everything, and that
 * an inherited `unfiled` would make it a second copy of this page.
 */
const query = vi.hoisted(() => ({ last: null as MeetingListQuery | null }));
/** The retry button is wired to this. */
const refetch = vi.hoisted(() => vi.fn());

let rows: MeetingResponse[];
let loading: boolean;
/** How many meetings exist at all, filed or not. Only the empty states ask. */
let workspaceTotal: number;

/* ---------------------------------------------------------------------------
 * The states a naive mock cannot express.
 *
 * A mock returning `{ data, isLoading }` is exactly the subset of RTK Query the
 * page used when it had this bug -- so it agreed with the bug. A failed request
 * and an empty one were indistinguishable to both, and no test could tell them
 * apart either.
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
 * screen, and part of what these tests can move.
 */
let folderRows: Project[];
let foldersLoading: boolean;
let foldersErrored: boolean;

/** What Settings knows about the person. The masthead greets from it. */
let displayName: string | null;

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
  // The masthead's greeting. Settings first, then the identity provider, then
  // nothing -- never the user id.
  useGetPreferencesQuery: () => ({ data: displayName === null ? {} : { displayName } }),
}));

// `isLoaded` and `sessionKey` are not decoration: the date window is remembered
// per sign-in, and nothing reads what was remembered until auth says which
// sign-in this is.
const auth = vi.hoisted(() => ({ sessionKey: "sess_1" }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    userId: "usr_1",
    mode: "clerk",
    profile: { name: "", email: "", imageUrl: "" },
    sessionKey: auth.sessionKey,
    isLoaded: true,
  }),
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

/** Narrow the list to a window, through the control somebody actually uses. */
async function pickWindow(label: RegExp) {
  await userEvent.click(screen.getByRole("button", { name: /Any time|Today|Last 7 days/ }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
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
  displayName = null;
  // The window outlives a page now, so without this it would outlive a test and
  // the order the suite happened to run in would decide what Home opened on.
  // See lib/preference-store.ts.
  window.localStorage.clear();
  auth.sessionKey = "sess_1";
});

/**
 * The list this page shows, and the one it does not.
 *
 * <p>`unfiled=true` is the whole of it, and it is asserted on the wire rather
 * than on the label. Both halves have been wrong at different times: a label
 * reading Recent over a query that fetched everything, and a query narrowed in
 * the browser over fifty rows that had already come back — which answered
 * "conversations outside a folder" with whichever of the fifty most recent
 * happened to be outside one, and looked right until somebody had more than
 * fifty meetings.
 */
describe("what Home asks for", () => {
  it("asks the server for what is outside a folder", () => {
    render(<HomePage />);

    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("asks for it on the very first query, not after a correction", () => {
    // Storage cannot be read while rendering, so the first render necessarily
    // holds the defaults. Asking then and again once the window is restored is
    // two requests and a list that changes under the reader; the query waits.
    render(<HomePage />);

    expect(lastQuery()?.size).toBe(50);
    expect(lastQuery()?.page).toBe(0);
    expect(lastQuery()?.unfiled).toBe(true);
  });

  it("keeps asking for it once a date window is chosen", async () => {
    // Two narrowings over one list. Losing one when the other moves is the bug
    // that follows from rebuilding the query object per control.
    render(<HomePage />);

    await pickWindow(/Last 7 days/);

    expect(lastQuery()?.unfiled).toBe(true);
    expect(lastQuery()?.from).toBeTruthy();
  });

  it("does not offer a way to widen it to the whole workspace", () => {
    // That is Library, a place in the band. A second control here doing the
    // same thing is the duplicate archive this redesign exists to remove.
    render(<HomePage />);

    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByText("All Conversations")).not.toBeInTheDocument();
  });
});

/**
 * The label under the heading.
 *
 * <p>"Recent" is the product's word for this list and the filter is about
 * folders, so the label is the only thing on screen that explains it. That was
 * true when it was a hint inside the picker's menu, and it is more true now
 * that there is no menu to open: a meeting recorded ten minutes ago inside a
 * folder is simply absent from a list called Recent, and the "Everything is in
 * a folder" screen behind it arrives with nothing to connect it to.
 *
 * <p><b>Do not drop this line.</b> Renaming the heading to "Unfiled" carries it
 * in the label instead; that was tried and reverted.
 */
describe("the label that explains the list", () => {
  it("says the list is what is outside your folders", () => {
    render(<HomePage />);

    expect(screen.getByText(/outside your folders/i)).toBeInTheDocument();
  });

  it("says where the rest of it is", () => {
    // The two read as a pair -- everything outside your folders, and everything
    // else. Said that way round they describe two lists rather than one list
    // and a property a meeting either has or does not.
    render(<HomePage />);

    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library");
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

/**
 * Where you are in the day, and whether anything needs a person.
 *
 * <p>The V2 concept had a "Needs you" block here built from cross-meeting
 * memory, which does not exist — the migrations dropped the tables. What
 * replaced it is derived from the list already on screen and costs no request,
 * which is the constraint that makes it impossible for it to be wrong.
 */
describe("the masthead", () => {
  it("greets by first name", async () => {
    displayName = "Priya Raman";
    render(<HomePage />);

    // First name only. "Good morning, Priya Raman" is a form letter.
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening), Priya$/,
    );
  });

  it("greets without a name rather than with an id", async () => {
    // An opaque key in the place a name goes does not read as "you". It reads
    // as somebody else's account, which is exactly how it was reported.
    render(<HomePage />);

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    expect(screen.queryByText(/usr_1/)).not.toBeInTheDocument();
  });

  it("says how many conversations are still being made", async () => {
    rows = [
      aMeeting({ id: "a", status: "TRANSCRIBING" }),
      aMeeting({ id: "b", status: "SUMMARIZING" }),
      aMeeting({ id: "c", status: "READY" }),
    ];
    render(<HomePage />);

    expect(await screen.findByText("2 conversations are still being made.")).toBeInTheDocument();
  });

  it("says when one could not be transcribed", async () => {
    // The one thing on this screen that genuinely needs a human, and previously
    // findable only by scrolling for a red badge.
    rows = [aMeeting({ id: "a", status: "FAILED" })];
    render(<HomePage />);

    expect(
      await screen.findByText("One conversation could not be transcribed."),
    ).toBeInTheDocument();
  });

  it("says nothing at all when nothing needs anything", async () => {
    rows = [aMeeting({ status: "READY" })];
    render(<HomePage />);

    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/still being made/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be transcribed/)).not.toBeInTheDocument();
  });

  it("claims nothing before the list has arrived", () => {
    // `undefined` is not an empty list. A masthead that reports "0 still being
    // made" from a request that has not answered is the same class of bug as an
    // empty state over a failed one.
    loading = true;
    render(<HomePage />);

    expect(screen.queryByText(/still being made/)).not.toBeInTheDocument();
  });
});

describe("when there is nothing to show", () => {
  it("says the rest is filed, and offers the way to it", () => {
    rows = [];
    workspaceTotal = 11;

    render(<HomePage />);

    // Without this the page offers Record and Import to somebody with a
    // hundred meetings, which reads as an archive that lost them.
    expect(screen.getByText("Everything is in a folder")).toBeInTheDocument();
    // A navigation now, not a control that flips a filter. The way out of an
    // empty list used to be a switch somebody had to remember never touching.
    expect(screen.getByRole("link", { name: "Go to Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("offers a first recording to an account with nothing in it", () => {
    rows = [];
    workspaceTotal = 0;

    render(<HomePage />);

    // The same empty list meaning the opposite thing. Home opens here, so this
    // is the first screen of a new account: answering it with "everything is in
    // a folder" and a button to another empty list would be the worst possible
    // first impression.
    expect(screen.getByText("No conversations")).toBeInTheDocument();
    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
  });

  it("still blames the date window first, since that is the likelier cause", async () => {
    rows = [];

    render(<HomePage />);
    await pickWindow(/^Today/);

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
 * come back, open another — and the control above the list used to reset every
 * time. Narrowing to last week was work you redid on every return.
 *
 * <p>So the choice is remembered, and the exception is the requirement: signing
 * out puts it back to the default. `unmount` then `render` here is literally
 * leaving Home and returning to it; the sign-in changing is somebody signing out
 * and back in.
 *
 * <p>These used to be asked of the scope picker, which was the control the
 * production report named. It is gone; the machinery is not, and neither is the
 * defect it was reported for — a value stored under session 1 being reported as
 * ready under session 2. The date window goes through the identical
 * `useStickyPreference`, so it is what asks now.
 */
describe("filters that stay where you left them", () => {
  it("opens on the date window you chose last time", async () => {
    const visit = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    expect(lastQuery()?.from).toBeTruthy();
    visit.unmount();

    render(<HomePage />);

    // The label, and a lower bound actually reaching the server. A restored
    // label over an unfiltered query is the version of this that looks right.
    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeInTheDocument();
    expect(lastQuery()?.from).toBeTruthy();
  });

  it("does not treat the previous sign-in's choice as this one's", async () => {
    // The half of the production report that was a real defect rather than a
    // product choice: a stored value belonging to session 1, still reported as
    // ready under session 2, decided the first query of the new sign-in.
    const visit = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    visit.unmount();

    auth.sessionKey = "sess_2";
    query.last = null;
    render(<HomePage />);

    expect(lastQuery()?.from).toBeFalsy();
  });

  it("remembers going back to the default just as firmly", async () => {
    const first = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    first.unmount();

    const second = render(<HomePage />);
    await pickWindow(/Any time/);
    second.unmount();

    // Choosing the default is a choice. Were it treated as "no opinion", the
    // next visit would reinstate last week and the control would quietly undo
    // what somebody had just told it.
    query.last = null;
    render(<HomePage />);
    expect(lastQuery()?.from).toBeFalsy();
    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
  });

  it("goes back to the defaults after a sign-out and sign-in", async () => {
    const visit = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    expect(lastQuery()?.from).toBeTruthy();
    visit.unmount();

    // A new session is what signing out and back in produces — as the same
    // person or as somebody else.
    auth.sessionKey = "sess_2";
    query.last = null;
    render(<HomePage />);

    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
    expect(lastQuery()?.from).toBeFalsy();
  });

  it("asks the server once, with the filter it restored", async () => {
    const visit = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    // Storage cannot be read while rendering, so the first render necessarily
    // holds the default. Asking then would fetch the whole list and fetch it
    // again narrowed -- two requests and a list that changes under the reader.
    expect(lastQuery()?.from).toBeTruthy();
  });

  it("does not drift when you leave for a meeting and return", () => {
    const visit = render(<HomePage />);
    expect(lastQuery()?.unfiled).toBe(true);
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    expect(lastQuery()?.unfiled).toBe(true);
  });
});

/**
 * An empty Recent, and the request that tells the two meanings apart.
 *
 * <h2>The bug this list's default once caused</h2>
 *
 * <p>Recent is `unfiled=true` on the wire — conversations that were never put
 * in a folder — so an account that had filed everything opened Home to a list
 * with nothing in it, and the page said "No conversations" and offered to help
 * with a first recording. The archive-lost screen, over a full archive, reached
 * by doing nothing.
 *
 * <p>What made it unrecoverable is that an empty list never said <em>which
 * filter had emptied it</em> — the same screen appeared whether the workspace
 * was empty or merely tidy. Home tells those apart now: an empty Recent asks the
 * server whether the workspace holds anything at all, and the answers get
 * opposite screens.
 *
 * <p>This is the common path rather than a corner, which is exactly why the
 * probe exists. Anybody narrowing this list further should move the probe with
 * it rather than through it.
 */
describe("the two things an empty list can mean", () => {
  it("says the meetings are filed rather than that there are none", () => {
    rows = [];
    workspaceTotal = 40;

    render(<HomePage />);

    expect(screen.getByText("Everything is in a folder")).toBeInTheDocument();
    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Library" })).toBeInTheDocument();
  });

  it("offers a first recording, not a folder hint, to an account with nothing in it", () => {
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
    expect(screen.getByRole("link", { name: "Go to Library" })).toBeInTheDocument();
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
    // filed conversations out, and the whole list is one navigation away.
    rows = [];
    workspaceTotal = 40;
    foldersErrored = true;

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing outside your folders")).toBeInTheDocument();
  });

  it("says nothing at all while the workspace probe is still in flight", () => {
    rows = [];
    probeLoading = true;

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
  });

  it("does not treat a failed workspace probe as proof the account is empty", () => {
    /*
     * The same rule, one layer down. The probe answers "is anything filed
     * elsewhere?", and reading a failed probe as zero produces the
     * first-recording screen for somebody whose meetings are all in folders.
     */
    rows = [];
    probeErrored = true;

    render(<HomePage />);

    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing outside your folders")).toBeInTheDocument();
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
 * A sign-in change under a page that is already open.
 *
 * <p>The other tests here start a fresh render for each session, which is what
 * a full page load does. Production does not always do that: signing out and
 * back in are both client navigations, so Home can be re-rendered under a new
 * `sessionKey` without ever unmounting — and that is the render in which the
 * previous session's remembered preference was still being reported as ready.
 */
describe("when the sign-in changes under an open page", () => {
  it("never asks with the previous session's filter", async () => {
    const view = render(<HomePage />);
    await pickWindow(/Last 7 days/);
    expect(lastQuery()?.from).toBeTruthy();

    query.last = null;
    auth.sessionKey = "sess_2";
    await act(async () => {
      view.rerender(<HomePage />);
    });

    expect(lastQuery()?.from).toBeFalsy();
  });

  it("starts the new sign-in on the default window", async () => {
    const view = render(<HomePage />);
    await pickWindow(/Last 7 days/);

    auth.sessionKey = "sess_2";
    await act(async () => {
      view.rerender(<HomePage />);
    });

    expect(screen.getByRole("button", { name: /Any time/ })).toBeInTheDocument();
  });

  it("keeps an explicit choice while the sign-in does not change", async () => {
    const view = render(<HomePage />);
    await pickWindow(/Last 7 days/);

    await act(async () => {
      view.rerender(<HomePage />);
    });

    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeInTheDocument();
    expect(lastQuery()?.from).toBeTruthy();
  });
});
