import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@/lib/types";

/**
 * The folder list in the rail.
 *
 * The heading is a link to every folder and the chevron beside it is the
 * collapse — two controls where there used to be one, because the row that used
 * to answer "show me all of them" sat at the foot of the list it was meant to
 * replace.
 *
 * The plus is hidden until the heading is hovered, which is a decision with a
 * cost: a control that only a mouse can find is one that half the people using
 * the product cannot press. So it stays in the document, focusable and named,
 * and only its opacity changes — and there is a test here saying so, because
 * `hidden` is exactly the shortcut somebody would reach for later.
 *
 * <h2>And what the section is allowed to claim</h2>
 *
 * <p>The second half of this file. `projects ?? []` drew a blank FOLDERS
 * section for an unresolved request, a first load, a dropped connection and a
 * 500 alike — identical to the account that genuinely has no folders, with no
 * skeleton and nothing to press. The mock below is therefore a whole query
 * state rather than a list, because every one of those situations is a
 * different combination of the same flags and the bug was that none of them was
 * being read.
 */
let query: ProjectsQuery;

const refetch = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => query,
}));

vi.mock("@/components/folder-dialog", () => ({
  FolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
}));

import { FolderTree } from "@/components/folder-tree";

function folder(id: string, name: string): Project {
  return { id, name, description: "", meetingCount: 0 } as Project;
}

const TWO = [folder("prj_1", "Client ABC"), folder("prj_2", "Q3 planning")];

/** As much of RTK Query's result as this component reads. */
interface ProjectsQuery {
  data: Project[] | undefined;
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => void;
}

/**
 * Every flag false and no body — then override the ones the situation means.
 *
 * <p>Spelling each state out this way is the point. The four that used to be
 * indistinguishable differ only in these booleans, and a helper that took a
 * list instead could not express any of them.
 */
function state(over: Partial<ProjectsQuery> = {}): ProjectsQuery {
  return {
    data: undefined,
    isUninitialized: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    refetch,
    ...over,
  };
}

const loading = () => state({ isLoading: true, isFetching: true });
const arrived = (data: Project[]) => state({ data, isSuccess: true });
const refetching = (data: Project[]) => state({ data, isSuccess: true, isFetching: true });
/** A refetch that failed keeps the last good body — RTK Query does not drop it. */
const refetchFailed = (data: Project[]) => state({ data, isError: true });
const failed = () => state({ isError: true });

const skeleton = () => screen.queryByText("Loading folders");
const loadError = () => screen.queryByText("Couldn't load folders");
const folderLink = (name: string) => screen.queryByRole("link", { name });

beforeEach(() => {
  vi.clearAllMocks();
  query = arrived(TWO);
});

describe("the list", () => {
  it("shows each folder, linked to itself", () => {
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.getByRole("link", { name: "Client ABC" })).toHaveAttribute(
      "href",
      "/folder/prj_1",
    );
    expect(screen.getByRole("link", { name: "Q3 planning" })).toBeInTheDocument();
  });

  it("collapses from the chevron, so a long list cannot push the nav off screen", async () => {
    render(<FolderTree onNavigate={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Collapse folders" }));

    expect(screen.queryByRole("link", { name: "Client ABC" })).not.toBeInTheDocument();
  });

  it("makes the heading itself the way to every folder", () => {
    render(<FolderTree onNavigate={() => {}} />);

    // It used to only collapse, which left "show me all of them" to a row at
    // the foot of the list — so seeing every folder meant opening a list of
    // folders and scrolling past them to a link.
    expect(screen.getByRole("link", { name: "Folders" })).toHaveAttribute("href", "/folders");
    expect(screen.queryByRole("link", { name: "All folders" })).not.toBeInTheDocument();
  });

  it("closes the rail when the heading is followed", async () => {
    const onNavigate = vi.fn();
    render(<FolderTree onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole("link", { name: "Folders" }));

    expect(onNavigate).toHaveBeenCalled();
  });

  it("shows nothing at all when there are no folders", () => {
    query = arrived([]);
    render(<FolderTree onNavigate={() => {}} />);

    // This section lists what exists. With nothing in it, an instruction is
    // the only entry — and /folders, which the heading leads to, has the room
    // to say what a folder is for and a button to make one.
    expect(
      screen.queryByRole("button", { name: "Create your first folder" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "All folders" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Folders" })).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------------------
 * What the section is allowed to say
 * ------------------------------------------------------------------------ */

describe("an answer that has not arrived", () => {
  it("does not read an unresolved request as an account with no folders", () => {
    /*
     * THE BUG, in the state it happened in. Nothing in flight, nothing cached,
     * nothing settled -- which is where the sidebar sits for the moment between
     * a session becoming ready and its first request going out, and where it
     * stays if that request is dropped. `projects ?? []` drew this as an empty
     * account.
     */
    query = state();
    render(<FolderTree onNavigate={() => {}} />);

    expect(skeleton()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not read a query that was never started as an empty one", () => {
    query = state({ isUninitialized: true });
    render(<FolderTree onNavigate={() => {}} />);

    expect(skeleton()).toBeInTheDocument();
  });

  it("shows a loading state on the first load", () => {
    query = loading();
    render(<FolderTree onNavigate={() => {}} />);

    // Named, not merely grey: a section that is silent for as long as it is
    // uncertain is unreadable to anybody not looking at it.
    expect(skeleton()).toBeInTheDocument();
    expect(loadError()).not.toBeInTheDocument();
  });
});

describe("an answer that arrived", () => {
  it("renders the folders it was given", () => {
    query = arrived(TWO);
    render(<FolderTree onNavigate={() => {}} />);

    expect(folderLink("Client ABC")).toBeInTheDocument();
    expect(skeleton()).not.toBeInTheDocument();
    expect(loadError()).not.toBeInTheDocument();
  });

  it("draws the empty section only for a settled, successful, genuinely empty answer", () => {
    query = arrived([]);
    render(<FolderTree onNavigate={() => {}} />);

    // The one route to a blank FOLDERS section. No skeleton, because nothing is
    // coming; no error, because nothing went wrong.
    expect(skeleton()).not.toBeInTheDocument();
    expect(loadError()).not.toBeInTheDocument();
    expect(folderLink("Client ABC")).not.toBeInTheDocument();
  });
});

describe("folders already on screen", () => {
  it("keeps them while they are being refetched", () => {
    query = refetching(TWO);
    render(<FolderTree onNavigate={() => {}} />);

    // Replacing a list somebody can see with a skeleton, to report news about a
    // copy nobody asked for, is throwing away the good answer for a worse one.
    expect(folderLink("Client ABC")).toBeInTheDocument();
    expect(folderLink("Q3 planning")).toBeInTheDocument();
    expect(skeleton()).not.toBeInTheDocument();
  });

  it("keeps them when the refetch fails", () => {
    query = refetchFailed(TWO);
    render(<FolderTree onNavigate={() => {}} />);

    // A background refresh failing says nothing about the folders. They are
    // still there, they are still correct, and they are still navigable.
    expect(folderLink("Client ABC")).toBeInTheDocument();
    expect(loadError()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a request that failed with nothing behind it", () => {
  it("says so, rather than showing an empty section", () => {
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    expect(loadError()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("offers a way to try again", () => {
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retries the real request rather than only the appearance of one", async () => {
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("cannot be queued up twice while a retry is in flight", async () => {
    query = state({ isError: true, isFetching: true });
    render(<FolderTree onNavigate={() => {}} />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("is quiet enough for a sidebar", () => {
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    // Two lines and a text button. The dashed card the meeting page uses would
    // be the loudest thing on the screen, shouting about a section most people
    // are not looking at.
    expect(screen.getByRole("alert")).toHaveTextContent(/^Couldn't load folders Try again$/);
  });

  it("still lets the folder list itself be reached", () => {
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    // The rail is broken, not the app. /folders may well load.
    expect(screen.getByRole("link", { name: "Folders" })).toHaveAttribute("href", "/folders");
    expect(screen.getByRole("button", { name: "Create a folder" })).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Collapse folders" }));

    await userEvent.click(screen.getByRole("button", { name: "Create a folder" }));

    // Otherwise the folder is created into a collapsed list and nothing on
    // screen changes.
    expect(screen.getByRole("button", { name: "Collapse folders" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("still works while the folders are failing to load", async () => {
    // Creating does not depend on reading. Losing the create button because a
    // GET failed would be a second bug caused by the fix for the first.
    query = failed();
    render(<FolderTree onNavigate={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Create a folder" }));

    expect(screen.getByTestId("folder-dialog")).toBeInTheDocument();
  });
});
