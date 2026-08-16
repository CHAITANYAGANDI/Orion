import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatConversation, ChatMessage, MeetingResponse, Project } from "@/lib/types";

/**
 * A folder's page: what is filed here, and an answer drawn only from it.
 *
 * <p>The list is the shape of the page, because that is what somebody opening a
 * folder came for. But the tests that matter are about the second claim — a
 * folder chat that quietly answers from the whole workspace is worse than no
 * folder chat, since it looks scoped, reads as scoped, and is not.
 */
const { askProject, chatQuery, deleteProject, updateProject, assign, push } = vi.hoisted(() => ({
  askProject: vi.fn(),
  chatQuery: vi.fn(),
  deleteProject: vi.fn(),
  updateProject: vi.fn(),
  assign: vi.fn(),
  push: vi.fn(),
}));

let project: Project | undefined;
let meetings: MeetingResponse[];
let messages: ChatMessage[];
let conversations: ChatConversation[];

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "prj_1" }),
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/api", () => ({
  useGetProjectQuery: () => ({ data: project, isLoading: false }),
  useGetProjectMeetingsQuery: () => ({ data: meetings }),
  useGetProjectChatQuery: (arg: unknown) => {
    chatQuery(arg);
    return { data: messages, isLoading: false, isError: false };
  },
  useGetProjectConversationsQuery: () => ({ data: conversations }),
  useAskProjectChatMutation: () => [
    (arg: unknown) => {
      askProject(arg);
      return { unwrap: () => Promise.resolve({ conversationId: "cnv_1" }) };
    },
    { isLoading: false },
  ],
  useCreateProjectConversationMutation: () => [
    () => ({ unwrap: () => Promise.resolve({ id: "cnv_2" }) }),
    { isLoading: false },
  ],
  useClearProjectChatMutation: () => [
    () => ({ unwrap: () => Promise.resolve() }),
    { isLoading: false },
  ],
  useUpdateProjectMutation: () => [
    (arg: unknown) => {
      updateProject(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useCreateProjectMutation: () => [
    () => ({ unwrap: () => Promise.resolve({}) }),
    { isLoading: false },
  ],
  useAssignProjectMutation: () => [
    (arg: unknown) => {
      assign(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useDeleteProjectMutation: () => [
    (id: string) => {
      deleteProject(id);
      return { unwrap: () => Promise.resolve({ unfiledMeetings: 3 }) };
    },
    { isLoading: false },
  ],
  useRenameConversationMutation: () => [vi.fn(), {}],
  useDeleteConversationMutation: () => [vi.fn(), {}],
  useDeleteChatExchangeMutation: () => [vi.fn(), { isLoading: false }],
}));

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

import ProjectPage from "@/app/(app)/projects/[id]/page";

beforeEach(() => {
  vi.clearAllMocks();
  project = {
    id: "prj_1",
    name: "Client ABC",
    description: "The ABC engagement",
    color: "",
    favorite: false,
    meetingCount: 3,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: "2026-08-01T09:00:00Z",
  };
  meetings = [
    {
      id: "mtg_1",
      title: "Discovery Call",
      status: "READY",
      tags: [],
      createdAt: "2026-08-01T10:00:00Z",
      durationSeconds: 1800,
    },
  ];
  messages = [];
  conversations = [];
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("ProjectPage", () => {
  it("lists what is filed here, under the folder's name", () => {
    render(<ProjectPage />);

    const list = screen.getByRole("region", { name: "Conversations in Client ABC" });

    expect(screen.getByRole("heading", { name: "Client ABC" })).toBeInTheDocument();
    expect(within(list).getByText("Conversation")).toBeInTheDocument();
    expect(within(list).getByText("Discovery Call")).toBeInTheDocument();
  });

  it("keeps the folder chat below the list", () => {
    render(<ProjectPage />);

    // Not what you open a folder to see, but the reason the grouping exists.
    expect(screen.getByText(/Ask Recallix about this folder/)).toBeInTheDocument();
  });

  it("marks a meeting whose notes are ready", () => {
    render(<ProjectPage />);

    // A mark carried by every row whether or not it has been processed says
    // nothing, and this list is where somebody checks what is ready to read.
    expect(screen.getByLabelText("Notes ready")).toBeInTheDocument();
  });

  it("stars the folder, which is what sorts it to the top of the rail", async () => {
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: "Star this folder" }));

    expect(updateProject).toHaveBeenCalledWith({ id: "prj_1", body: { favorite: true } });
  });

  it("takes a meeting out of the folder without deleting it", async () => {
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: "Actions for Discovery Call" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove from folder/ }));

    // Deleting a recording lives on the meeting page, behind the erase menu,
    // where what is about to go can be named one grain at a time.
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith({ meetingId: "mtg_1", projectId: null }),
    );
  });

  it("says exactly what the answers are grounded in", () => {
    render(<ProjectPage />);

    expect(screen.getByText(/grounded in these 3 meetings and nothing else/)).toBeInTheDocument();
  });

  it("asks the project, not the workspace", async () => {
    render(<ProjectPage />);

    await userEvent.type(
      screen.getByPlaceholderText("Ask about Client ABC…"),
      "Where does this stand?",
    );
    await userEvent.click(screen.getByRole("button", { name: "" }));

    // A chat that looks scoped and is not is worse than no scoped chat.
    await waitFor(() =>
      expect(askProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: "prj_1", question: "Where does this stand?" }),
      ),
    );
  });

  it("offers questions about a body of work, not about one call", async () => {
    render(<ProjectPage />);

    // "Summarize this meeting" has no meaning here; "where does this stand"
    // is the question no single meeting can answer.
    expect(screen.getByText("Where does this project stand?")).toBeInTheDocument();
  });

  it("promises the meetings survive when the folder is deleted", async () => {
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Folder/ }));

    // The confirm text is the safeguard: a folder is cheap to delete and six
    // hours of audio is not.
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("meetings are kept");
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("prj_1"));
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("3 meetings moved to Unfiled"),
    );
    expect(push).toHaveBeenCalledWith("/projects");
  });

  it("keeps the delete when the confirm is dismissed", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete Folder/ }));

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("links to a search already narrowed to this folder", async () => {
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: "Folder actions" }));

    expect(screen.getByRole("menuitem", { name: /Search in folder/ })).toHaveAttribute(
      "href",
      "/search?project=prj_1",
    );
  });

  it("says so when the folder is gone", () => {
    project = undefined;
    render(<ProjectPage />);

    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
  });
});
