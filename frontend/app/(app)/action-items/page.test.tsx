import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionItemListQuery, ActionItemOverview, ActionItemResponse } from "@/lib/types";

/**
 * The workspace tracker.
 *
 * <p>Two things are being guarded. Every view has to be a question asked of the
 * server rather than a slice taken in the browser — otherwise the number on a
 * tab and the rows under it come from different places and eventually disagree,
 * which is worse than having no number. And "My tasks" must never guess: nothing
 * joins an account to the name a transcript spells, so an unanswered question
 * has to stay a question rather than quietly become everybody's tasks.
 */
const { listQueries, bulk, updatePreferences } = vi.hoisted(() => ({
  listQueries: [] as ActionItemListQuery[],
  bulk: vi.fn(),
  updatePreferences: vi.fn(),
}));

let items: ActionItemResponse[];
let overview: ActionItemOverview;

vi.mock("@/lib/api", () => ({
  useGetActionItemsQuery: (q: ActionItemListQuery) => {
    listQueries.push(q);
    return { data: { content: items, page: 0, size: 100, totalElements: items.length, totalPages: 1 }, isLoading: false, isFetching: false };
  },
  useGetActionItemOverviewQuery: () => ({ data: overview, isLoading: false }),
  useBulkPatchActionItemsMutation: () => [
    (arg: unknown) => {
      bulk(arg);
      return { unwrap: () => Promise.resolve({ changed: 2 }) };
    },
    { isLoading: false },
  ],
  useUpdatePreferencesMutation: () => [
    (arg: unknown) => {
      updatePreferences(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  // Reached through the row and the new-item dialog, neither of which is under
  // test here.
  usePatchActionItemMutation: () => [() => ({ unwrap: () => Promise.resolve({}) }), { isLoading: false }],
  useDeleteActionItemMutation: () => [() => ({ unwrap: () => Promise.resolve() }), { isLoading: false }],
  useGetActionItemCommentsQuery: () => ({ data: [], isLoading: false }),
  useAddActionItemCommentMutation: () => [() => ({ unwrap: () => Promise.resolve({}) }), { isLoading: false }],
  useDeleteActionItemCommentMutation: () => [() => ({ unwrap: () => Promise.resolve() }), { isLoading: false }],
  useCreateActionItemMutation: () => [() => ({ unwrap: () => Promise.resolve({}) }), { isLoading: false }],
  useGetMeetingsQuery: () => ({ data: { content: [] } }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import ActionItemsPage from "@/app/(app)/action-items/page";

function item(over: Partial<ActionItemResponse> = {}): ActionItemResponse {
  return {
    id: "ai_1",
    meetingId: "mtg_1",
    meetingTitle: "Sprint planning",
    title: "Finish the JWT validation",
    ownerName: "Priya",
    dueDate: "friday",
    dueOn: "2026-08-14",
    dueStatus: "OVERDUE",
    daysUntilDue: -2,
    priority: "high",
    status: "OPEN",
    edited: false,
    commentCount: 0,
    ...over,
  };
}

/** The parameters of the most recent list request. */
function lastQuery() {
  return listQueries.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  listQueries.length = 0;
  items = [item(), item({ id: "ai_2", title: "Draft the rollout plan", ownerName: "Marcus" })];
  overview = {
    counts: { open: 7, overdue: 2, dueSoon: 3, mine: 4, done: 11 },
    owners: [
      { name: "Priya", count: 5 },
      { name: "Marcus", count: 2 },
    ],
    me: "Priya",
  };
});

describe("ActionItemsPage views", () => {
  it("opens on what is left rather than on everything", () => {
    render(<ActionItemsPage />);

    // The page is opened to find out what is outstanding; a first screen of
    // work finished six months ago answers a question nobody asked.
    expect(lastQuery()).toMatchObject({ status: "OPEN_ANY" });
    expect(lastQuery().due).toBeUndefined();
  });

  it("asks the server for each view instead of filtering what it already has", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("button", { name: /Overdue/ }));
    expect(lastQuery()).toMatchObject({ status: "OPEN_ANY", due: "overdue" });

    await userEvent.click(screen.getByRole("button", { name: /Due soon/ }));
    expect(lastQuery()).toMatchObject({ status: "OPEN_ANY", due: "soon" });

    await userEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(lastQuery()).toMatchObject({ status: "DONE" });
  });

  it("labels each view with its own count", () => {
    render(<ActionItemsPage />);

    expect(screen.getByRole("button", { name: /Overdue 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Due soon 3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Done 11/ })).toBeInTheDocument();
  });
});

describe("ActionItemsPage filters", () => {
  it("filters by owner", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByLabelText("Owner"));
    await userEvent.click(screen.getByRole("option", { name: /Priya/ }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ owner: "Priya" }));
  });

  it("offers the names actually assigned work, with how much", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByLabelText("Owner"));

    // A free-text owner box only works if you spell the name the way the
    // transcript spells it.
    expect(screen.getByRole("option", { name: "Priya (5)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Marcus (2)" })).toBeInTheDocument();
  });

  it("can ask for the ones nobody owns", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByLabelText("Owner"));
    await userEvent.click(screen.getByRole("option", { name: "Unassigned" }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ owner: "unassigned" }));
  });

  it("drops the owner filter inside My tasks, which is already one", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("button", { name: /My tasks/ }));

    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ mine: true });
  });
});

describe("ActionItemsPage my tasks", () => {
  it("asks who I am rather than showing everybody's work", async () => {
    overview = { ...overview, me: null };
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("button", { name: /My tasks/ }));

    expect(screen.getByText("Which of these is you?")).toBeInTheDocument();
    expect(screen.queryByText("Finish the JWT validation")).not.toBeInTheDocument();
  });

  it("offers the names in the workspace as the answer", async () => {
    overview = { ...overview, me: null };
    render(<ActionItemsPage />);
    await userEvent.click(screen.getByRole("button", { name: /My tasks/ }));

    await userEvent.click(screen.getByRole("button", { name: "Priya" }));

    // Picked rather than typed: a name spelled differently from the transcript
    // returns an empty list and no explanation for it.
    expect(updatePreferences).toHaveBeenCalledWith({ displayName: "Priya" });
  });
});

describe("ActionItemsPage bulk", () => {
  it("offers nothing until something is selected", () => {
    render(<ActionItemsPage />);

    expect(screen.queryByRole("button", { name: /Mark complete/ })).not.toBeInTheDocument();
  });

  it("completes a selection in one request", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("checkbox", { name: /Select .*JWT/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Select .*rollout/ }));
    await userEvent.click(screen.getByRole("button", { name: /Mark complete/ }));

    await waitFor(() =>
      expect(bulk).toHaveBeenCalledWith({ ids: ["ai_1", "ai_2"], status: "DONE" }),
    );
  });

  it("selects everything shown at once", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("reopens rather than completes when looking at finished work", async () => {
    render(<ActionItemsPage />);
    await userEvent.click(screen.getByRole("button", { name: /Done/ }));

    await userEvent.click(screen.getByRole("checkbox", { name: /Select .*JWT/ }));

    // Offering "mark complete" against a list of completed things is a button
    // that does nothing, and the count it reports would be zero.
    expect(screen.getByRole("button", { name: /Reopen/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark complete/ })).not.toBeInTheDocument();
  });

  it("drops the selection when the list changes underneath it", async () => {
    render(<ActionItemsPage />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Select .*JWT/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Overdue/ }));

    // A selection that outlived its list would complete rows nobody can see.
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

describe("ActionItemsPage empty", () => {
  it("says which question came back empty", async () => {
    items = [];
    render(<ActionItemsPage />);
    await userEvent.click(screen.getByRole("button", { name: /Overdue/ }));

    expect(screen.getByText("Nothing is late.")).toBeInTheDocument();
  });
});

describe("ActionItemsPage adding", () => {
  it("can record a commitment nobody said out loud", async () => {
    render(<ActionItemsPage />);

    await userEvent.click(screen.getByRole("button", { name: /New action item/ }));

    // Every item belongs to a meeting, so the dialog has to ask which.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("What needs to happen")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Meeting")).toBeInTheDocument();
  });
});
