import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@/lib/types";

/**
 * The control that files a meeting.
 *
 * <p>Two rules, both about not stranding somebody. A workspace with no projects
 * gets no picker at all, because a dropdown with nothing in it advertises a
 * feature and then refuses to do it. And "No folder" is a real option rather than
 * a placeholder — a picker you can get into but not out of would leave a meeting
 * permanently filed under the first project somebody clicked by mistake.
 */
let projects: Project[];

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({ data: projects }),
}));

import { ProjectPicker } from "@/components/project-picker";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    description: "",
    color: "",
    favorite: false,
    meetingCount: 0,
    createdAt: "2026-08-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
  };
}

const onChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  projects = [project("prj_1", "Client ABC"), project("prj_2", "Interviews")];
});

describe("ProjectPicker", () => {
  it("offers every project", async () => {
    render(<ProjectPicker value={null} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Project"));

    expect(screen.getByRole("option", { name: "Client ABC" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Interviews" })).toBeInTheDocument();
  });

  it("files a meeting on the first click", async () => {
    render(<ProjectPicker value={null} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Project"));
    await userEvent.click(screen.getByRole("option", { name: "Client ABC" }));

    expect(onChange).toHaveBeenCalledWith("prj_1");
  });

  it("can take a meeting back out again", async () => {
    render(<ProjectPicker value="prj_1" onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("Project"));
    await userEvent.click(screen.getByRole("option", { name: "No folder" }));

    // Null, not the sentinel: the caller says "no project", not "a project
    // called __none".
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows what a meeting is already filed under", () => {
    render(<ProjectPicker value="prj_2" onChange={onChange} />);
    expect(screen.getByLabelText("Project")).toHaveTextContent("Interviews");
  });

  it("renders nothing when there is nowhere to file", () => {
    projects = [];
    const { container } = render(<ProjectPicker value={null} onChange={onChange} />);

    expect(container).toBeEmptyDOMElement();
  });
});
