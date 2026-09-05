import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, MeetingListQuery, Page } from "@/lib/types";

/**
 * Now — the greeting, the list, and the two screens an empty list can be.
 *
 * <h2>What left this file, and what it left behind</h2>
 *
 * <p>There was a scope picker above the list with two options: <i>Recent
 * Conversations</i> (`unfiled=true` — everything outside your folders) and
 * <i>All Conversations</i>. It is gone, and so is the parameter: <i>All</i> is
 * a page now (**Library**), and <i>Recent</i> asks for the newest twenty
 * <em>wherever they are filed</em>. Roughly half the tests below used to drive
 * that control or explain what it hid.
 *
 * <p>Three groups went, and each is accounted for:
 *
 * <ul>
 *   <li><b>"the wire says unfiled"</b> — <b>inverted</b>, not dropped. The
 *       assertion now is that this page never sends the parameter, which is the
 *       guard that makes every screen below unnecessary: with no filter, no
 *       filed meeting can be missing from Now.</li>
 *   <li><b>"a stored choice survives a visit and not a sign-in"</b> — re-asked
 *       of the date window. The production defect was a value stored under
 *       session 1 still being reported as ready under session 2, which is a
 *       property of `useStickyPreference` and not of the scope. The window goes
 *       through the identical machinery.</li>
 *   <li><b>"an empty Recent must say which filter emptied it"</b> — the three
 *       screens that answered this (everything-is-filed, the contradiction, the
 *       unresolved probe) are <b>unreachable</b>, because the filter they
 *       explained does not exist. The probe that fed them is gone with them.
 *       The rule underneath — <i>only a settled, successful, genuinely empty
 *       response may claim an empty account</i> — is untouched and has a whole
 *       describe block of its own below. That is the rule the production bug
 *       was about.</li>
 * </ul>
 *
 * <p>What can no longer be asked here is what happens when All is chosen. That
 * is `app/(app)/library/page.test.tsx`.
 */
const query = vi.hoisted(() => ({ last: null as MeetingListQuery | null }));
/** The retry button is wired to this. */
const refetch = vi.hoisted(() => vi.fn());

let rows: MeetingResponse[];
/** How many exist behind the page. Drives the "showing the newest N" line. */
let total: number | null;
let loading: boolean;
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
    query.last = q;
    // Filtering happens in the query, so the mock returns what it was asked
    // for. Asserting on the request is the point: a client-side filter would
    // pass a test that fed it both kinds of row and hid one.
    if (loading) return result<Page<MeetingResponse>>(undefined, { isLoading: true });
    // An error keeps whatever was cached -- RTK does not throw the last good
    // page away -- so `noData` is what separates "failed with nothing" from
    // "failed over meetings already on screen".
    const data = noData ? undefined : aPage(rows, total ?? rows.length);
    return result(data, { isFetching: fetching, isError: errored });
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
  rows = [aMeeting()];
  total = null;
  displayName = null;
  // The window outlives a page now, so without this it would outlive a test and
  // the order the suite happened to run in would decide what Home opened on.
  // See lib/preference-store.ts.
  window.localStorage.clear();
  auth.sessionKey = "sess_1";
});

/**
 * The list this page shows, and the parameter it must never send again.
 *
 * <p>`unfiled=true` is what Recent used to mean: a folder filter under a name
 * about time. It made this page lie in a way nobody would report as a bug —
 * record a meeting inside a folder, and it is filed there and gone from Recent,
 * which is not what recent means.
 *
 * <p>So the assertion is inverted rather than deleted, and it is on the wire
 * rather than on the label. Both halves have been wrong at different times: a
 * label reading Recent over a query that fetched everything, and a query
 * narrowed in the browser over rows that had already come back.
 *
 * <p>This test is load-bearing for the whole file. Three empty-state screens
 * were deleted along with the filter, on the grounds that nothing here can hide
 * a meeting any more. If the parameter ever comes back, that stops being true
 * and the screens are needed again — so this is the guard that has to fail
 * first.
 */
describe("what Home asks for", () => {
  it("never asks the server to hide filed conversations", () => {
    render(<HomePage />);

    expect(lastQuery()?.unfiled).toBeUndefined();
  });

  it("still does not, once a date window is chosen", async () => {
    // Two narrowings over one list, and rebuilding the query object per control
    // is how the other one comes back.
    render(<HomePage />);

    await pickWindow(/Last 7 days/);

    expect(lastQuery()?.unfiled).toBeUndefined();
    expect(lastQuery()?.from).toBeTruthy();
  });

  it("asks for a short page, which is what makes it recent", () => {
    // The bound is the difference between this page and Library — both ask the
    // same question of the same endpoint, and this one asks for the top of the
    // answer. A page of fifty here would make the two lists the same list.
    render(<HomePage />);

    expect(lastQuery()?.size).toBe(20);
    expect(lastQuery()?.page).toBe(0);
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
 * The label under the heading, and the line under the list.
 *
 * <p>The label used to carry the whole explanation for a list that hid filed
 * meetings, and the file it lived in said in as many words: <i>do not drop
 * this line</i>. It has nothing to explain away now — so what it says instead
 * is the one thing about this list that is not obvious, which is that filing a
 * conversation does not take it off the page.
 *
 * <p>The truncation line is the new load-bearing one. A page showing twenty of
 * two hundred conversations, with nothing at the bottom saying so, is a list
 * somebody scrolls to the end of and believes — the same lie as a filter that
 * does not name itself, one level along.
 */
describe("the lines that explain the list", () => {
  it("says that filing a conversation does not hide it from here", () => {
    render(<HomePage />);

    expect(screen.getByText(/wherever they are filed/i)).toBeInTheDocument();
  });

  it("no longer claims the list is what is outside your folders", () => {
    // It was true and is not. Leaving it would describe a filter that was
    // removed precisely because the description was the only thing carrying it.
    render(<HomePage />);

    expect(screen.queryByText(/outside your folders/i)).not.toBeInTheDocument();
  });

  it("admits when it is showing only the newest of many", () => {
    rows = Array.from({ length: 20 }, (_, i) => aMeeting({ id: `mtg_${i}`, title: `Meeting ${i}` }));
    total = 214;
    render(<HomePage />);

    expect(screen.getByText(/Showing the 20 most recent of/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All of them are in Library/ })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("says nothing about truncation when nothing is truncated", () => {
    // A page that always claims to be a subset is as uninformative as one that
    // never does.
    rows = [aMeeting()];
    render(<HomePage />);

    expect(screen.queryByText(/most recent of/)).not.toBeInTheDocument();
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

/**
 * Nothing to show, and which of the two reasons it is.
 *
 * <p>There were four screens here. Three of them existed to explain
 * `unfiled=true` — that the meetings were in folders, or that they could not
 * be because there are none, or that the probe deciding between those had not
 * answered. The filter is gone and so are they: nothing on this page hides a
 * conversation, so an empty list means the window is empty or the account is,
 * and both are known from the response already on screen.
 *
 * <p>The rule those screens were built on is a different thing and is not
 * touched. It has its own block further down: an empty list is a *claim about
 * the account*, and only a settled, successful, genuinely empty response may
 * make it.
 */
describe("when there is nothing to show", () => {
  it("blames the date window when there is one", async () => {
    rows = [];

    render(<HomePage />);
    await pickWindow(/^Today/);

    expect(screen.getByText(/Nothing from Today/)).toBeInTheDocument();
    // Not the first-recording screen. A filter that empties the list has to say
    // so, or an archive that is merely narrowed reads as one that lost
    // everything.
    expect(screen.queryByText("No conversations")).not.toBeInTheDocument();
  });

  it("offers both ways out of a narrowed list", async () => {
    rows = [];

    render(<HomePage />);
    await pickWindow(/^Today/);

    expect(screen.getByRole("button", { name: "Show any time" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("says the account is empty only when nothing is narrowing the list", () => {
    rows = [];

    render(<HomePage />);

    expect(screen.getByText("No conversations")).toBeInTheDocument();
  });

  it("never claims a folder is hiding anything", () => {
    // The screen this replaces. It was correct while Recent meant unfiled;
    // saying it now would send somebody hunting through folders for meetings
    // that are already on this page.
    rows = [];

    render(<HomePage />);

    expect(screen.queryByText("Everything is in a folder")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing outside your folders")).not.toBeInTheDocument();
  });

  it("points a genuinely empty account at the two ways to start", () => {
    rows = [];

    render(<HomePage />);

    expect(screen.getByRole("link", { name: /Record/ })).toHaveAttribute(
      "href",
      "/record?r=%2Fhome",
    );
    expect(screen.getByRole("link", { name: /Import/ })).toHaveAttribute("href", "/upload");
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
    // The page is left and returned to all day. Whatever it asks for on the way
    // in, it has to ask for the same thing on the way back -- including the
    // parameter it must never send.
    const visit = render(<HomePage />);
    expect(lastQuery()?.size).toBe(20);
    visit.unmount();

    query.last = null;
    render(<HomePage />);

    expect(lastQuery()?.size).toBe(20);
    expect(lastQuery()?.unfiled).toBeUndefined();
    expect(lastQuery()?.from).toBeFalsy();
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
