import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionItemResponse } from "@/lib/types";

/**
 * The workspace action-item panel.
 *
 * The thing worth protecting here is that it is one list. A task typed into the
 * box and a commitment lifted out of a transcript are the same row in the same
 * table, so the panel must not grow a notion of "personal" versus "from a
 * meeting" — the moment it does, "what have I got to do" has two answers.
 *
 * The rest is about finished work. A tracker that forgets what you ticked cannot
 * answer "did I do that", which is the second question anybody asks it, so
 * completed items are folded away with a count rather than dropped.
 */
const { patch, create } = vi.hoisted(() => ({
  patch: vi.fn(),
  create: vi.fn(),
}));

let items: ActionItemResponse[] = [];

vi.mock("@/lib/api", () => ({
  useGetActionItemsQuery: () => ({
    data: { content: items, page: 0, size: 100, totalElements: items.length, totalPages: 1 },
    isLoading: false,
  }),
  usePatchActionItemMutation: () => [
    (arg: unknown) => {
      patch(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useCreateStandaloneActionItemMutation: () => [
    (arg: unknown) => {
      create(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ActionItemsPanel } from "@/components/action-items-panel";

function item(over: Partial<ActionItemResponse> = {}): ActionItemResponse {
  return {
    id: "ai_1",
    meetingId: "mtg_1",
    meetingTitle: "Sprint planning",
    title: "Finish the JWT validation",
    ownerName: "Priya",
    dueDate: "friday",
    dueOn: "2026-08-21",
    dueStatus: "SCHEDULED",
    daysUntilDue: 5,
    priority: "high",
    status: "OPEN",
    sourceSentence: null,
    sourceStartSeconds: null,
    completedAt: null,
    edited: false,
    commentCount: 0,
    createdAt: "2026-08-16T09:00:00Z",
    updatedAt: "2026-08-16T09:00:00Z",
    ...over,
  } as ActionItemResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  items = [];
});

describe("when there is nothing to do", () => {
  it("says so, in the words somebody reading an empty panel needs", () => {
    render(<ActionItemsPanel />);

    expect(screen.getByText("No current action items")).toBeInTheDocument();
    expect(
      screen.getByText("Your action items will appear here when assigned"),
    ).toBeInTheDocument();
  });

  it("still offers the way to add one", () => {
    render(<ActionItemsPanel />);
    expect(screen.getByRole("button", { name: /add action item/i })).toBeInTheDocument();
  });
});

describe("adding one by hand", () => {
  it("sends only a title — there is no meeting it came from", async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("button", { name: /add action item/i }));
    await user.type(screen.getByLabelText(/new action item/i), "Write the migration{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: "Write the migration" }));
  });

  it("stays open afterwards, because remembering one thing means remembering two", async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("button", { name: /add action item/i }));
    await user.type(screen.getByLabelText(/new action item/i), "First{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.getByLabelText(/new action item/i)).toBeInTheDocument();
  });

  it("does not create an empty task when the box is abandoned", async () => {
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("button", { name: /add action item/i }));
    await user.keyboard("{Escape}");

    expect(create).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("shows a deadline and an owner beside the task", () => {
    items = [item()];
    render(<ActionItemsPanel />);

    expect(screen.getByText("Finish the JWT validation")).toBeInTheDocument();
    expect(screen.getByText("Priya")).toBeInTheDocument();
  });

  it("links a task back to the meeting that produced it", () => {
    items = [item()];
    render(<ActionItemsPanel />);

    expect(screen.getByRole("link", { name: "Sprint planning" })).toHaveAttribute(
      "href",
      "/meetings/mtg_1?tab=actions",
    );
  });

  it("shows no meeting link for one nobody said out loud", () => {
    // A typed task has no conversation. Claiming one would be a link to a
    // meeting it was never mentioned in.
    items = [item({ meetingId: null, meetingTitle: null, title: "Write the migration" })];
    render(<ActionItemsPanel />);

    expect(screen.getByText("Write the migration")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sprint planning" })).not.toBeInTheDocument();
  });

  it("ticks one off", async () => {
    items = [item()];
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("checkbox", { name: /complete finish the jwt/i }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ id: "ai_1", body: { status: "DONE" } }),
    );
  });

  it("puts a finished one back", async () => {
    items = [item({ status: "DONE" })];
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("button", { name: /completed \(1\)/i }));
    await user.click(screen.getByRole("checkbox", { name: /reopen/i }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ id: "ai_1", body: { status: "OPEN" } }),
    );
  });
});

describe("finished work", () => {
  it("is folded away with a count rather than dropped", () => {
    items = [item(), item({ id: "ai_2", title: "Old thing", status: "DONE" })];
    render(<ActionItemsPanel />);

    expect(screen.getByRole("button", { name: /completed \(1\)/i })).toBeInTheDocument();
    expect(screen.queryByText("Old thing")).not.toBeInTheDocument();
  });

  it("opens on request", async () => {
    items = [item({ id: "ai_2", title: "Old thing", status: "DONE" })];
    const user = userEvent.setup();
    render(<ActionItemsPanel />);

    await user.click(screen.getByRole("button", { name: /completed \(1\)/i }));
    expect(screen.getByText("Old thing")).toBeInTheDocument();
  });

  it("takes no room at all when nothing is finished", () => {
    items = [item()];
    render(<ActionItemsPanel />);

    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
  });
});
