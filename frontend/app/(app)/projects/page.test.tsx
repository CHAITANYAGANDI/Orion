import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@/lib/types";

/**
 * The folder list.
 *
 * <p>The row is the whole page: a name, how much is in it, when it last changed,
 * and the two things you can do to it. Two of those are worth guarding.
 *
 * <p><i>Deleting a folder must never read as deleting its meetings.</i> The
 * confirmation says what survives, because "delete" over a folder full of
 * recordings reads as worse than it is — and somebody who believes it keeps
 * folders they do not want.
 *
 * <p><i>The star outranks the sort.</i> Whichever column header was last
 * clicked, a starred folder is first; it is the only thing on this page that is
 * a statement about what somebody is working on rather than about the data.
 */
const { update, remove, confirm } = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
}));

let folders: Project[];

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({ data: folders, isLoading: false }),
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

import FoldersPage from "@/app/(app)/projects/page";

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
  window.confirm = confirm;
  confirm.mockReturnValue(true);
});

describe("the list", () => {
  it("shows each folder and how much is in it", () => {
    render(<FoldersPage />);

    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("1 conversation")).toBeInTheDocument();
  });

  it("counts in the plural when it should", () => {
    folders = [folder({ meetingCount: 4 })];
    render(<FoldersPage />);

    expect(screen.getByText("4 conversations")).toBeInTheDocument();
  });

  it("links a folder to itself", () => {
    render(<FoldersPage />);

    expect(screen.getByRole("link", { name: /Meetings/ })).toHaveAttribute(
      "href",
      "/projects/prj_1",
    );
  });

  it("lists only folders — unfiled meetings are Home's job", () => {
    render(<FoldersPage />);

    // This page was once the only meeting list there was. Home lists everything
    // now, filed or not, so nothing is hidden by leaving Unfiled out of here.
    expect(screen.queryByText(/Unfiled/)).not.toBeInTheDocument();
  });

  it("says what a folder is for when there are none", () => {
    folders = [];
    render(<FoldersPage />);

    expect(screen.getByText("No folders yet")).toBeInTheDocument();
  });
});

describe("ordering", () => {
  it("opens on what changed most recently", () => {
    folders = [
      folder({ id: "old", name: "Older", updatedAt: "2026-01-01T09:00:00Z" }),
      folder({ id: "new", name: "Newer", updatedAt: "2026-08-10T09:00:00Z" }),
    ];
    render(<FoldersPage />);

    const names = screen.getAllByRole("link").map((el) => el.textContent);
    expect(names[0]).toContain("Newer");
  });

  it("sorts by name when the column is clicked", async () => {
    folders = [
      folder({ id: "b", name: "Beta", updatedAt: "2026-08-10T09:00:00Z" }),
      folder({ id: "a", name: "Alpha", updatedAt: "2026-01-01T09:00:00Z" }),
    ];
    render(<FoldersPage />);

    await userEvent.click(screen.getByRole("button", { name: /Name/ }));

    expect(screen.getAllByRole("link")[0].textContent).toContain("Alpha");
  });

  it("puts a starred folder first whichever column is sorted", () => {
    folders = [
      folder({ id: "recent", name: "Recent", updatedAt: "2026-08-10T09:00:00Z" }),
      folder({ id: "pinned", name: "Pinned", favorite: true, updatedAt: "2026-01-01T09:00:00Z" }),
    ];
    render(<FoldersPage />);

    expect(screen.getAllByRole("link")[0].textContent).toContain("Pinned");
  });
});

describe("the row menu", () => {
  async function openMenu() {
    render(<FoldersPage />);
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
  it("opens the form from the header", async () => {
    render(<FoldersPage />);

    await userEvent.click(screen.getByRole("button", { name: /New folder/ }));

    expect(await screen.findByRole("heading", { name: "Create a folder" })).toBeInTheDocument();
  });
});
