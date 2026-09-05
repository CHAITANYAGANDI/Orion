import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, MeetingListQuery, Page } from "@/lib/types";

/**
 * Library — everything you have.
 *
 * <p>This was an option in a dropdown on Home called "All Conversations". The
 * two things worth pinning are the two ways that move could have gone wrong.
 *
 * <p><b>It must ask for everything.</b> The whole distinction between this page
 * and Home is one query parameter: Home sends `unfiled=true` and gets the
 * meetings that were never filed, this sends nothing and gets the archive. A
 * Library that inherited the flag would be a second copy of Home under a
 * different name, and it would look completely right until somebody opened a
 * folder and found meetings the "everything" list had never shown them.
 *
 * <p><b>It must not read a failure as an empty archive.</b> The screen that
 * says you have nothing is the screen a person with two hundred meetings should
 * never see, and `data?.content ?? []` is the one line that produces it.
 */
const query = vi.hoisted(() => ({ last: null as MeetingListQuery | null }));
const refetch = vi.hoisted(() => vi.fn());

let rows: MeetingResponse[];
/** Nothing usable is cached -- `data` is undefined, not an empty page. */
let noData: boolean;
let loading: boolean;
let errored: boolean;

function aPage(content: MeetingResponse[], total = content.length): Page<MeetingResponse> {
  return { content, page: 0, size: 50, totalElements: total, totalPages: 1 };
}

/** An RTK Query result with every flag the page reads, kept mutually consistent. */
function result<T>(
  data: T | undefined,
  opts: { isLoading?: boolean; isFetching?: boolean; isError?: boolean } = {},
) {
  const isLoading = opts.isLoading ?? false;
  const isError = opts.isError ?? false;
  return {
    data,
    isLoading,
    isFetching: opts.isFetching ?? isLoading,
    isError,
    isSuccess: !isLoading && !isError && data !== undefined,
    isUninitialized: false,
    error: isError ? { status: 500, data: { message: "boom" } } : undefined,
    refetch,
  };
}

vi.mock("@/lib/api", () => ({
  // The per-meeting poll a processing row runs under its socket subscription.
  useGetMeetingQuery: () => ({ data: undefined }),
  useGetMeetingsQuery: (q: MeetingListQuery, options?: { skip?: boolean }) => {
    if (options?.skip) {
      return { ...result<Page<MeetingResponse>>(undefined), isUninitialized: true };
    }
    query.last = q;
    if (loading) return result<Page<MeetingResponse>>(undefined, { isLoading: true });
    return result(noData ? undefined : aPage(rows), { isError: errored });
  },
}));

/*
 * The folder list has its own file — components/folder-table.test.tsx — which
 * carries every assertion the old /folders page had plus the three-state rules
 * it inherited from the rail's version. Rendering the real one here would drag
 * four mutation hooks and two dialogs into a test about a meeting list, and
 * would test the same rows twice.
 */
vi.mock("@/components/folder-table", () => ({
  FolderTable: () => <section data-testid="folders" />,
}));

// Both the date window and anything else remembered per sign-in wait on this.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_1", sessionKey: "sess_1", isLoaded: true }),
}));

import LibraryPage from "@/app/(app)/library/page";

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

beforeEach(() => {
  vi.clearAllMocks();
  query.last = null;
  rows = [aMeeting()];
  noData = false;
  loading = false;
  errored = false;
  window.sessionStorage.clear();
});

describe("the list", () => {
  it("asks for everything, filed or not", async () => {
    render(<LibraryPage />);

    await screen.findByText("Tuesday design review");
    // The one line that separates this page from Home. `unfiled: true` here
    // would make Library a second copy of Home under another name.
    expect(query.last?.unfiled).toBeUndefined();
  });

  it("lists the conversations that came back", async () => {
    rows = [aMeeting(), aMeeting({ id: "mtg_2", title: "Pricing sync" })];
    render(<LibraryPage />);

    expect(await screen.findByText("Tuesday design review")).toBeInTheDocument();
    expect(screen.getByText("Pricing sync")).toBeInTheDocument();
  });

  it("links a conversation to itself", async () => {
    render(<LibraryPage />);

    expect(await screen.findByRole("link", { name: /Tuesday design review/ })).toHaveAttribute(
      "href",
      "/meetings/mtg_1",
    );
  });
});

describe("when it cannot be read", () => {
  it("says so, rather than saying the archive is empty", async () => {
    // The two readings are opposites and only one of them is recoverable by
    // waiting. `data?.content ?? []` reads "no answer" as "the answer is none",
    // which tells somebody with two hundred meetings that they have none.
    errored = true;
    noData = true;
    render(<LibraryPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't load your library/);
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
  });

  it("offers the way back", async () => {
    errored = true;
    noData = true;
    render(<LibraryPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalled();
  });

  it("keeps whatever is already on screen when a refetch fails over it", async () => {
    // RTK does not throw the last good page away, and neither should this: an
    // error screen replacing a list somebody is reading is worse than the error.
    errored = true;
    noData = false;
    render(<LibraryPage />);

    expect(await screen.findByText("Tuesday design review")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("when there is genuinely nothing", () => {
  it("says the archive is empty and how it stops being empty", async () => {
    rows = [];
    render(<LibraryPage />);

    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
  });

  it("does not claim a folder is hiding anything", async () => {
    // Home needs that screen because its list is narrowed by default. This one
    // is everything, so there is nothing for a folder to be hiding — saying so
    // would send somebody looking through folders for meetings that do not
    // exist.
    rows = [];
    render(<LibraryPage />);

    await screen.findByText("Nothing here yet");
    expect(screen.queryByText(/Everything is in a folder/)).not.toBeInTheDocument();
  });
});

describe("the folders", () => {
  it("are on this page, above the conversations", async () => {
    // They were /folders, reached from a section in the navigation rail. Both
    // are gone: a folder is a way of grouping what you have, so it belongs on
    // the page called what you have — and with the rail gone, a separate route
    // for them would be a destination with no entrance.
    render(<LibraryPage />);

    const folders = screen.getByTestId("folders");
    expect(folders).toBeInTheDocument();
    // Order matters. The folders are the smaller, slower list people scan
    // first; the archive is what they scroll.
    const conversations = await screen.findByRole("heading", { name: "Conversations" });
    expect(folders.compareDocumentPosition(conversations)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
