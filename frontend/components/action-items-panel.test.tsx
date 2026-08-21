import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionItemResponse } from "@/lib/types";

/**
 * The panel for what you gave yourself to do.
 *
 * This file used to open by insisting the opposite of what it now tests: that
 * the panel is one list, that a typed task and a commitment out of a transcript
 * are the same row in the same table, and that it must never distinguish them —
 * because the moment it did, "what have I got to do" would have two answers.
 *
 * That was the right worry and the wrong conclusion. It did have two answers
 * anyway, and then three: the same commitment sat on its meeting, in this
 * panel, and on a tracker page, with nothing to say which of them ticking it
 * off was supposed to happen in. Splitting by where the row came from is what
 * gives each one exactly one home. A commitment is read and completed on the
 * meeting that produced it, beside the sentence it came from. What is left here
 * is what somebody typed, which belongs to no meeting.
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
/** What the panel last asked the server for. */
let lastQuery: Record<string, unknown> | undefined;

vi.mock("@/lib/api", () => ({
  useGetActionItemsQuery: (q: Record<string, unknown>) => {
    lastQuery = q;
    return {
      data: { content: items, page: 0, size: 100, totalElements: items.length, totalPages: 1 },
      isLoading: false,
    };
  },
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
  lastQuery = undefined;
});

describe("when there is nothing to do", () => {
  it("says so, and says where the meeting ones went", () => {
    render(<ActionItemsPanel />);

    expect(screen.getByText("Nothing on your list")).toBeInTheDocument();
    // The copy matters more than usual here. This panel used to list every
    // action item in the workspace and now lists only what you type, so for
    // most people it went from full to empty in one release. An empty box with
    // no explanation reads as a fault rather than a change.
    expect(screen.getByText(/stays on that meeting/i)).toBeInTheDocument();
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

  it("asks only for the items nobody's transcript produced", () => {
    items = [item({ meetingId: null, meetingTitle: null, title: "Write the migration" })];
    render(<ActionItemsPanel />);

    // The whole point of the panel now. Without this flag a commitment made in
    // a meeting is in two lists at once, and neither says which one ticking it
    // off is supposed to happen in.
    expect(lastQuery).toMatchObject({ standalone: true });
  });

  it("shows no meeting link, because nothing in it has a meeting", () => {
    items = [item({ meetingId: null, meetingTitle: null, title: "Write the migration" })];
    render(<ActionItemsPanel />);

    expect(screen.getByText("Write the migration")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
