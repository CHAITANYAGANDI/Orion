import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatConversation, ChatMessage, MeetingResponse, Project } from "@/lib/types";

/**
 * A project's page, which is really two claims side by side: these meetings,
 * and an answer drawn only from them.
 *
 * <p>The tests that matter are about that second claim. A project chat that
 * quietly answers from the whole workspace is worse than no project chat — it
 * looks scoped, reads as scoped, and is not — so the wiring is checked, and so
 * is the promise the page makes about what it read.
 */
const { askProject, chatQuery, deleteProject, push } = vi.hoisted(() => ({
  askProject: vi.fn(),
  chatQuery: vi.fn(),
  deleteProject: vi.fn(),
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
    () => ({ unwrap: () => Promise.resolve() }),
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
  it("shows the project's meetings beside the chat", () => {
    render(<ProjectPage />);

    // Reading an answer and seeing what could have produced it is one act.
    expect(screen.getByText("Discovery Call")).toBeInTheDocument();
    expect(screen.getByText(/Ask Recallix about this project/)).toBeInTheDocument();
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

  it("promises the meetings survive when the project is deleted", async () => {
    render(<ProjectPage />);

    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));

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

    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("links to a search already narrowed to this project", () => {
    render(<ProjectPage />);

    expect(screen.getByRole("link", { name: /Search in project/ })).toHaveAttribute(
      "href",
      "/search?project=prj_1",
    );
  });

  it("says so when the project is gone", () => {
    project = undefined;
    render(<ProjectPage />);

    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
  });
});
