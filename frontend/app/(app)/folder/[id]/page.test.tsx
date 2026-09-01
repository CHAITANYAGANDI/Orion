import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatConversation, ChatMessage, MeetingResponse, Project } from "@/lib/types";

/**
 * A folder's page: what is filed here.
 *
 * <p>The list is the whole page now. The folder chat that used to sit under it
 * was removed on request, and the folder's own actions moved to the top bar, so
 * two of the groups below assert absence rather than behaviour — an absence
 * nobody wrote down is indistinguishable from a regression six months later.
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

import ProjectPage from "@/app/(app)/folder/[id]/page";

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

  it("carries no chat any more", () => {
    render(<ProjectPage />);

    // "Ask Reverie about this folder" was removed on request. The server side
    // of it is untouched, so this asserts the removal was a decision rather
    // than something that fell out of a refactor.
    expect(screen.queryByText(/Ask Reverie/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Ask about Client ABC/)).not.toBeInTheDocument();
  });

  it("does not ask the server for a folder chat it no longer shows", () => {
    render(<ProjectPage />);

    // The hook going unused is the difference between removing a feature and
    // hiding one that still costs a request on every visit.
    expect(chatQuery).not.toHaveBeenCalled();
    expect(askProject).not.toHaveBeenCalled();
  });

  it("keeps rename and delete out of the page body", () => {
    render(<ProjectPage />);

    // They moved to the top bar beside Record; see
    // components/folder-header-actions.test.tsx. Two menus for one set of
    // actions is the state this asserts against.
    expect(screen.queryByRole("button", { name: "Folder actions" })).not.toBeInTheDocument();
  });

  it("says so when the folder is gone", () => {
    project = undefined;
    render(<ProjectPage />);

    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
  });
});
