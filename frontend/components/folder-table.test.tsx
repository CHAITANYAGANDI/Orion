import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@/lib/types";

/**
 * The folder list.
 *
 * <p>The row is the whole of it: a name, how much is in it, when it last
 * changed, and the two things you can do to it. Two of those are worth
 * guarding.
 *
 * <p><i>Deleting a folder must never read as deleting its meetings.</i> The
 * confirmation says what survives, because "delete" over a folder full of
 * recordings reads as worse than it is — and somebody who believes it keeps
 * folders they do not want.
 *
 * <p><i>The star outranks the sort.</i> Whichever column header was last
 * clicked, a starred folder is first; it is the only thing here that is a
 * statement about what somebody is working on rather than about the data.
 *
 * <h2>Two files merged into this one</h2>
 *
 * <p>This was `app/(app)/folders/page.test.tsx`. That route is a redirect now —
 * folders are part of Library — and every assertion it held is below, unchanged
 * except for the one about where the New folder button lives.
 *
 * <p>The second half came from `components/folder-tree.test.tsx`, the navigation
 * rail's folder section, which is retired with the rail. It is here because it
 * held a rule this list did not have and needed: `projects ?? []` reads *no
 * answer* as *the answer is none*, so an unresolved request, a first load, a
 * dropped connection and a 500 all drew "No folders yet" — a confident sentence
 * about somebody's account, produced by a failure to reach the server. Losing
 * those tests with the component would have quietly un-fixed that.
 */
const { update, remove, confirm, refetch } = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  refetch: vi.fn(),
}));

let folders: Project[] | undefined;
let loading: boolean;
let fetching: boolean;
let errored: boolean;

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({
    data: folders,
    isLoading: loading,
    isFetching: fetching || loading,
    isError: errored,
    isSuccess: !loading && !errored && folders !== undefined,
    isUninitialized: false,
    refetch,
  }),
  useUpdateProjectMutation: () => [
    (arg: unknown) => {
      update(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useDeleteProjectMutation: () => [
    (id: string) => {
      remove(id);
      return { unwrap: () => Promise.resolve({ unfiledMeetings: 3 }) };
    },
    { isLoading: false },
  ],
  useCreateProjectMutation: () => [() => ({ unwrap: () => Promise.resolve({}) }), { isLoading: false }],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { FolderTable } from "@/components/folder-table";

function folder(over: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "Meetings",
    description: "",
    color: "",
    favorite: false,
    meetingCount: 1,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  folders = [folder()];
  loading = false;
  fetching = false;
  errored = false;
  window.confirm = confirm;
  confirm.mockReturnValue(true);
});

describe("the list", () => {
  it("shows each folder and how much is in it", () => {
    render(<FolderTable />);

    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("1 conversation")).toBeInTheDocument();
  });

  it("counts in the plural when it should", () => {
    folders = [folder({ meetingCount: 4 })];
    render(<FolderTable />);

    expect(screen.getByText("4 conversations")).toBeInTheDocument();
  });

  it("links a folder to itself", () => {
    render(<FolderTable />);

    expect(screen.getByRole("link", { name: /Meetings/ })).toHaveAttribute(
      "href",
      "/folder/prj_1",
    );
  });

  it("lists only folders — the conversations are the list underneath", () => {
    // This was once the only meeting list there was, and carried a row for
    // meetings in no folder. Library lists everything below it now, so nothing
    // is hidden by leaving them out.
    render(<FolderTable />);

    expect(screen.queryByText(/No folder/)).not.toBeInTheDocument();
  });

  it("says what a folder is for when there are none", () => {
    folders = [];
    render(<FolderTable />);

    expect(screen.getByText("No folders yet")).toBeInTheDocument();
  });
});

describe("ordering", () => {
  it("opens on what changed most recently", () => {
    folders = [
      folder({ id: "old", name: "Older", updatedAt: "2026-01-01T09:00:00Z" }),
      folder({ id: "new", name: "Newer", updatedAt: "2026-08-10T09:00:00Z" }),
    ];
    render(<FolderTable />);

    const names = screen.getAllByRole("link").map((el) => el.textContent);
    expect(names[0]).toContain("Newer");
  });

  it("sorts by name when the column is clicked", async () => {
    folders = [
      folder({ id: "b", name: "Beta", updatedAt: "2026-08-10T09:00:00Z" }),
      folder({ id: "a", name: "Alpha", updatedAt: "2026-01-01T09:00:00Z" }),
    ];
    render(<FolderTable />);

    await userEvent.click(screen.getByRole("button", { name: /Name/ }));

    expect(screen.getAllByRole("link")[0].textContent).toContain("Alpha");
  });

  it("puts a starred folder first whichever column is sorted", () => {
    folders = [
      folder({ id: "recent", name: "Recent", updatedAt: "2026-08-10T09:00:00Z" }),
      folder({ id: "pinned", name: "Pinned", favorite: true, updatedAt: "2026-01-01T09:00:00Z" }),
    ];
    render(<FolderTable />);

    expect(screen.getAllByRole("link")[0].textContent).toContain("Pinned");
  });
});

describe("the row menu", () => {
  async function openMenu() {
    render(<FolderTable />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Meetings" }));
  }

  it("stars a folder", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Star folder/ }));

    expect(update).toHaveBeenCalledWith({ id: "prj_1", body: { favorite: true } });
  });

  it("offers to take the star off one that has it", async () => {
    folders = [folder({ favorite: true })];
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Remove star/ }));

    expect(update).toHaveBeenCalledWith({ id: "prj_1", body: { favorite: false } });
  });

  it("opens the rename form on the folder it was opened from", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Rename Folder/ }));

    expect(await screen.findByRole("heading", { name: "Rename folder" })).toBeInTheDocument();
  });

  it("says the meetings survive before deleting the folder", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Folder/ }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("prj_1"));
    // The sentence people read at the moment they are deciding.
    expect(confirm.mock.calls[0][0]).toMatch(/are kept/);
  });

  it("deletes nothing when the confirmation is declined", async () => {
    confirm.mockReturnValue(false);
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Folder/ }));

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("creating", () => {
  /*
   * THIS USED TO ASSERT THE OPPOSITE, and the reversal is deliberate.
   *
   * <p>The button was in the top bar, and the old file said so: "It is in the
   * top bar on this page, where Import and Record sit everywhere else." That was
   * right while the bar belonged to the page. It does not any more — what is up
   * there is a global band carrying the same five controls on every screen in
   * the app, and a New folder button in it would offer one page's action from
   * all of them.
   *
   * <p>So the list took its own action back, and what these pin is the thing
   * that made the old arrangement worth writing down: there is exactly ONE of
   * them above the list, never two a centimetre apart.
   */
  it("puts a New folder button beside the heading, and only one", () => {
    render(<FolderTable />);

    expect(screen.getAllByRole("button", { name: /New folder/ })).toHaveLength(1);
  });

  it("opens the dialog from it", async () => {
    render(<FolderTable />);

    await userEvent.click(screen.getByRole("button", { name: /New folder/ }));

    expect(await screen.findByRole("heading", { name: "Create a folder" })).toBeInTheDocument();
  });

  it("keeps one in the empty state, where it is being explained", async () => {
    folders = [];
    render(<FolderTable />);

    // Two now, and that is not what the old file argued against: the heading
    // button and the one inside the explanation are a page-length apart, and
    // somebody reading "a folder groups meetings by the work they belong to" is
    // going to press the thing directly under it rather than scroll back.
    const buttons = screen.getAllByRole("button", { name: /New folder/ });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]);

    expect(await screen.findByRole("heading", { name: "Create a folder" })).toBeInTheDocument();
  });
});

/**
 * No answer is not the answer "none".
 *
 * <h2>The bug, which this list had and the rail's version did not</h2>
 *
 * <p>It decided what to draw with `folders ?? []` guarded only by `isLoading`.
 * So an unresolved request, a dropped connection and a 500 all arrived as a
 * list of length zero and were drawn exactly like an account with no folders —
 * "No folders yet", with an explanation of what folders are for, shown to
 * somebody who has twenty of them.
 *
 * <p>`isLoading` does not cover it either: it is true only for the very first
 * load of a cache entry. A refetch sets `isFetching`; an error sets neither.
 *
 * <p>The rule: the empty state is a *claim about the account*, and only a
 * settled, successful, genuinely empty response may make it.
 */
describe("when the request does not simply succeed", () => {
  const EMPTY = "No folders yet";

  it("shows a skeleton before the first answer, not an empty list", () => {
    folders = undefined;
    loading = true;
    const { container } = render(<FolderTable />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("does not claim an empty account when there is simply no data yet", () => {
    // The exact `?? []` case, with no error to mask it: every other test here
    // with no data also has an error, and the error branch answers first — so
    // mutating the rule to treat undefined as empty would leave them passing.
    folders = undefined;
    render(<FolderTable />);

    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it("says the request failed, and offers a retry", async () => {
    folders = undefined;
    errored = true;
    render(<FolderTable />);

    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load your folders/);
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps backend detail off the screen", () => {
    folders = undefined;
    errored = true;
    render(<FolderTable />);

    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
  });

  it("keeps the folders on screen when a background refetch fails", () => {
    // Known-good rows beat a failed refresh. Throwing away the good copy
    // because the new one did not arrive is strictly worse than showing it.
    errored = true;
    render(<FolderTable />);

    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the folders on screen during a background refetch", () => {
    fetching = true;
    render(<FolderTable />);

    expect(screen.getByText("Meetings")).toBeInTheDocument();
  });

  it("still draws the empty state for an account that genuinely has none", () => {
    // The fix must not make the empty state unreachable — that would trade a
    // false negative for a permanent skeleton on a new account.
    folders = [];
    render(<FolderTable />);

    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });

  it("hides the sort header while the failure is on screen", () => {
    // Two column headers over an error message are controls for a list that is
    // not there.
    folders = undefined;
    errored = true;
    render(<FolderTable />);

    expect(screen.queryByRole("button", { name: /Last Updated/ })).not.toBeInTheDocument();
  });
});
