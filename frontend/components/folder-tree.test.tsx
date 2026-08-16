import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@/lib/types";

/**
 * The folder list in the rail.
 *
 * The plus is hidden until the heading is hovered, which is a decision with a
 * cost: a control that only a mouse can find is one that half the people using
 * the product cannot press. So it stays in the document, focusable and named,
 * and only its opacity changes — and there is a test here saying so, because
 * `hidden` is exactly the shortcut somebody would reach for later.
 */
let folders: Project[];

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({ data: folders, isLoading: false }),
}));

vi.mock("@/components/folder-dialog", () => ({
  FolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
}));

import { FolderTree } from "@/components/folder-tree";

function folder(id: string, name: string): Project {
  return { id, name, description: "", meetingCount: 0 } as Project;
}

beforeEach(() => {
  vi.clearAllMocks();
  folders = [folder("prj_1", "Client ABC"), folder("prj_2", "Q3 planning")];
});

describe("the list", () => {
  it("shows each folder, linked to itself", () => {
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.getByRole("link", { name: "Client ABC" })).toHaveAttribute(
      "href",
      "/projects/prj_1",
    );
    expect(screen.getByRole("link", { name: "Q3 planning" })).toBeInTheDocument();
  });

  it("collapses, so a long list cannot push the nav off the screen", async () => {
    render(<FolderTree onNavigate={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: /Folders/ }));

    expect(screen.queryByRole("link", { name: "Client ABC" })).not.toBeInTheDocument();
  });

  it("tells the empty case what to do rather than linking it somewhere empty", () => {
    folders = [];
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.getByRole("button", { name: "Create your first folder" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "All folders" })).not.toBeInTheDocument();
  });
});

describe("the plus", () => {
  it("is reachable by name, not only by hovering", () => {
    render(<FolderTree onNavigate={() => {}} />);

    // Rendered conditionally on hover it would be invisible to a keyboard and a
    // screen reader both. Opacity is a paint; `hidden` would be a removal.
    expect(screen.getByRole("button", { name: "Create a folder" })).toBeInTheDocument();
  });

  it("opens the form", async () => {
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.queryByTestId("folder-dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create a folder" }));

    expect(screen.getByTestId("folder-dialog")).toBeInTheDocument();
  });

  it("expands the section it is about to add to", async () => {
    render(<FolderTree onNavigate={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /Folders/ }));

    await userEvent.click(screen.getByRole("button", { name: "Create a folder" }));

    // Otherwise the folder is created into a collapsed list and nothing on
    // screen changes.
    expect(screen.getByRole("button", { name: /Folders/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
