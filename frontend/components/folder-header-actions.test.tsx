import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { Project } from "@/lib/types";

/**
 * Rename, search and delete, for the folder currently open.
 *
 * <p>These moved out of the folder page and into the top bar. The tests came
 * with them, because the one that matters is not about where the menu is: it is
 * the confirmation before a delete. A folder is one click to remove and the
 * recordings inside it are hours of audio, and the sentence promising those
 * survive is the only thing standing between somebody and believing otherwise.
 *
 * <p>The second group is about the folder not having loaded yet. The header
 * renders on every page, so this component mounts before its query resolves on
 * a hard refresh — and a menu offering to delete something it cannot name is
 * worse than a menu that arrives a moment late.
 */
const { deleteProject, push } = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  push: vi.fn(),
}));

let folder: Project | undefined;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  useGetProjectQuery: () => ({ data: folder }),
  useDeleteProjectMutation: () => [
    (id: string) => {
      deleteProject(id);
      return { unwrap: () => Promise.resolve({ unfiledMeetings: 3 }) };
    },
    { isLoading: false },
  ],
}));

vi.mock("@/components/folder-dialog", () => ({
  FolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
}));

import { FolderHeaderActions } from "@/components/folder-header-actions";
import { resetSearchOverlay, useSearchOverlay } from "@/lib/search-overlay";

/** Reads the store the menu writes to, so a test can see what it opened with. */
function Overlay() {
  const overlay = useSearchOverlay();
  return <p data-testid="overlay">{overlay.open ? overlay.initial : "closed"}</p>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSearchOverlay();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  folder = { id: "prj_1", name: "Client ABC", description: "", meetingCount: 3 } as Project;
});

async function openMenu() {
  render(<FolderHeaderActions folderId="prj_1" />);
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
}

describe("the menu", () => {
  it("says what it is, since it is an icon between two labelled buttons", () => {
    render(<FolderHeaderActions folderId="prj_1" />);

    const trigger = screen.getByRole("button", { name: "More options" });
    // The tooltip and the accessible name are the same words on purpose.
    expect(trigger).toHaveAttribute("title", "More options");
  });

  it("offers rename, search and delete", async () => {
    await openMenu();

    expect(screen.getByRole("menuitem", { name: /Rename folder/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Search in folder/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete folder/ })).toBeInTheDocument();
  });

  it("opens the rename form", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Rename folder/ }));

    expect(await screen.findByTestId("folder-dialog")).toBeInTheDocument();
  });

  it("opens the search box already narrowed to this folder", async () => {
    render(<Overlay />);
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Search in folder/ }));

    // It used to be a link to /search?project=prj_1. There is no /search: the
    // box is the search, and `in:"…"` is the grammar it parses. The trailing
    // space puts the cursor past the filter, so the next keystroke is the term.
    expect(screen.getByTestId("overlay")).toHaveTextContent('in:"Client ABC"');
  });
});

describe("deleting", () => {
  it("promises the meetings survive, before asking", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete folder/ }));

    // A folder is cheap to delete and six hours of audio is not. Said before
    // rather than after, or somebody keeps folders they do not want.
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("meetings are kept");
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("prj_1"));
  });

  it("says how many meetings moved out of it", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete folder/ }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("3 meetings moved out of it"),
      ),
    );
  });

  it("leaves the page it was deleted from", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete folder/ }));

    // Otherwise the page underneath is a folder that no longer exists. Library
    // rather than /folders: the folder list is part of that page now, and the
    // old route is a redirect -- landing on it would be one navigation to reach
    // the same screen.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/library"));
  });

  it("does nothing when the confirm is dismissed", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Delete folder/ }));

    expect(deleteProject).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("before the folder has loaded", () => {
  it("renders nothing at all", () => {
    folder = undefined;
    render(<FolderHeaderActions folderId="prj_1" />);

    // A delete behind a menu that cannot name what it deletes, and a
    // confirmation reading “Delete “undefined”?”.
    expect(screen.queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
  });
});
