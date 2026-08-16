import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, Project } from "@/lib/types";

/**
 * The project tree.
 *
 * <p>What is worth asserting is the loading discipline. A workspace with twenty
 * projects renders twenty rows, and fetching every one's meetings up front would
 * be twenty requests to draw a page where nineteen are collapsed. So the branch
 * loads when it opens — invisible in a screenshot, obvious in a network tab, and
 * the kind of thing an innocent refactor undoes.
 */
const { projectMeetings, unfiledQuery, createProject } = vi.hoisted(() => ({
  projectMeetings: vi.fn(),
  unfiledQuery: vi.fn(),
  createProject: vi.fn(),
}));

let projects: Project[];

function meeting(id: string, title: string): MeetingResponse {
  return {
    id,
    title,
    status: "READY",
    tags: [],
    createdAt: "2026-08-01T10:00:00Z",
    durationSeconds: 1800,
  };
}

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({ data: projects, isLoading: false }),
  useGetProjectMeetingsQuery: (id: string) => {
    projectMeetings(id);
    return { data: [meeting("mtg_1", "Sprint Planning")], isLoading: false };
  },
  useGetUnfiledMeetingsQuery: (_arg: unknown, opts?: { skip?: boolean }) => {
    if (!opts?.skip) unfiledQuery();
    return {
      data: opts?.skip ? undefined : [meeting("mtg_9", "Unsorted call")],
      isLoading: false,
    };
  },
  useCreateProjectMutation: () => [
    (body: unknown) => {
      createProject(body);
      return { unwrap: () => Promise.resolve({ id: "prj_new" }) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import ProjectsPage from "@/app/(app)/projects/page";

beforeEach(() => {
  vi.clearAllMocks();
  projects = [
    {
      id: "prj_1",
      name: "Recallix Development",
      description: "The product build",
      color: "",
      meetingCount: 3,
      createdAt: "2026-07-01T09:00:00Z",
      updatedAt: "2026-08-01T09:00:00Z",
    },
  ];
});

describe("ProjectsPage", () => {
  it("shows each project with how much is in it", () => {
    render(<ProjectsPage />);

    expect(screen.getByText("Recallix Development")).toBeInTheDocument();
    // The count is what makes the row worth reading, and says in advance
    // whether asking the project anything can work.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("The product build")).toBeInTheDocument();
  });

  it("does not fetch a project's meetings until it is opened", async () => {
    render(<ProjectsPage />);

    expect(projectMeetings).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText("Expand Recallix Development"));

    await waitFor(() => expect(projectMeetings).toHaveBeenCalledWith("prj_1"));
    expect(screen.getByText("Sprint Planning")).toBeInTheDocument();
  });

  it("closes a branch again", async () => {
    render(<ProjectsPage />);

    await userEvent.click(screen.getByLabelText("Expand Recallix Development"));
    await screen.findByText("Sprint Planning");
    await userEvent.click(screen.getByLabelText("Collapse Recallix Development"));

    expect(screen.queryByText("Sprint Planning")).not.toBeInTheDocument();
  });

  it("keeps unfiled meetings reachable rather than hidden", async () => {
    render(<ProjectsPage />);

    // A grouping feature that makes ungrouped things harder to find has taken
    // more than it gave.
    expect(unfiledQuery).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText("Expand unfiled meetings"));

    expect(await screen.findByText("Unsorted call")).toBeInTheDocument();
  });

  it("creates a project and opens it", async () => {
    render(<ProjectsPage />);

    await userEvent.type(screen.getByLabelText("New project name"), "Client ABC");
    await userEvent.click(screen.getByRole("button", { name: /Create/ }));

    expect(createProject).toHaveBeenCalledWith({ name: "Client ABC" });
    // An empty project that stays collapsed looks like nothing happened.
    await waitFor(() => expect(screen.getByLabelText("New project name")).toHaveValue(""));
  });

  it("will not create a project with no name", async () => {
    render(<ProjectsPage />);

    await userEvent.type(screen.getByLabelText("New project name"), "   ");

    expect(screen.getByRole("button", { name: /Create/ })).toBeDisabled();
  });

  it("says what to do when there are no projects yet", () => {
    projects = [];
    render(<ProjectsPage />);

    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
  });
});
