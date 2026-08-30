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
const { patch, create, refetch } = vi.hoisted(() => ({
  patch: vi.fn(),
  create: vi.fn(),
  refetch: vi.fn(),
}));

let items: ActionItemResponse[] = [];
/** What the panel last asked the server for. */
let lastQuery: Record<string, unknown> | undefined;

/**
 * How the request is going.
 *
 * <p>The mock used to return `{ data, isLoading: false }` and nothing else,
 * which quietly asserted that the only two states worth testing were "loading"
 * and "done" -- the exact assumption that let a failed request render "Nothing
 * on your list". The full flag set is here so the panel can be put in the
 * states RTK Query actually produces.
 */
let queryState:
  | "success"
  | "loading"
  | "uninitialized"
  | "error"
  | "refetching"
  | "failed-refetch" = "success";

function queryResult() {
  const page = {
    content: items,
    page: 0,
    size: 100,
    totalElements: items.length,
    totalPages: 1,
  };
  const settled = { isUninitialized: false, refetch };
  switch (queryState) {
    case "uninitialized":
      /*
       * Nothing asked yet. The trap: every flag reads as "settled with
       * nothing" -- `isLoading` is false, so anything keyed off it alone falls
       * straight through to the empty message for a question that has not been
       * put to the server.
       */
      return {
        refetch,
        isUninitialized: true,
        data: undefined,
        isLoading: false,
        isFetching: false,
        isError: false,
        isSuccess: false,
      };
    case "loading":
      return {
        ...settled,
        data: undefined,
        isLoading: true,
        isFetching: true,
        isError: false,
        isSuccess: false,
      };
    case "error":
      // Failed with nothing cached behind it.
      return {
        ...settled,
        data: undefined,
        isLoading: false,
        isFetching: false,
        isError: true,
        isSuccess: false,
      };
    case "refetching":
      return {
        ...settled,
        data: page,
        isLoading: false,
        isFetching: true,
        isError: false,
        isSuccess: true,
      };
    case "failed-refetch":
      // RTK Query keeps the last good body when a refetch fails.
      return {
        ...settled,
        data: page,
        isLoading: false,
        isFetching: false,
        isError: true,
        isSuccess: true,
      };
    default:
      return {
        ...settled,
        data: page,
        isLoading: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
      };
  }
}

vi.mock("@/lib/api", () => ({
  useGetActionItemsQuery: (q: Record<string, unknown>) => {
    lastQuery = q;
    return queryResult();
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
  queryState = "success";
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

/**
 * The same rule as the meeting page and the Home list: an empty state is a
 * claim about the server's answer, so it needs one.
 *
 * <p>This panel had the Home-side-pane version of the bug. `data?.content ?? []`
 * meant a failed request produced "Nothing on your list" over somebody's
 * to-do list -- with an explanation underneath saying where their items had
 * gone, which made it read as deliberate rather than broken.
 */
describe("what the panel shows when the request does not simply succeed", () => {
  it("does not claim an empty list when the request failed", () => {
    queryState = "error";

    render(<ActionItemsPanel />);

    expect(screen.queryByText("Nothing on your list")).toBeNull();
    expect(screen.getByText(/couldn't load your action items/i)).toBeInTheDocument();
  });

  it("says the items are still there, and offers a retry wired to refetch", async () => {
    queryState = "error";

    render(<ActionItemsPanel />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText(/still on your list/i)).toBeInTheDocument();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("announces the failure to assistive technology", () => {
    queryState = "error";

    render(<ActionItemsPanel />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("does not claim an empty list before the first response", () => {
    queryState = "loading";

    render(<ActionItemsPanel />);

    expect(screen.queryByText("Nothing on your list")).toBeNull();
    expect(screen.queryByText(/couldn't load/i)).toBeNull();
  });

  it("does not claim an empty list for a question nobody has asked yet", () => {
    // `isLoading` is false on a query that has not started, so a panel keyed off
    // it alone announces an empty list for a request that was never made. This
    // is why the decision reads `isUninitialized` too.
    queryState = "uninitialized";

    render(<ActionItemsPanel />);

    expect(screen.queryByText("Nothing on your list")).toBeNull();
    expect(screen.queryByText(/couldn't load/i)).toBeNull();
  });

  it("keeps the items on screen during a background refetch", () => {
    items = [item({ id: "a", title: "Book the room" })];
    queryState = "refetching";

    render(<ActionItemsPanel />);

    expect(screen.getByText("Book the room")).toBeInTheDocument();
  });

  it("keeps the items on screen when a background refetch fails", () => {
    // The priority rule. A transient failure must not make a visible list
    // disappear -- the cached copy is still the best thing on the screen.
    items = [item({ id: "a", title: "Book the room" })];
    queryState = "failed-refetch";

    render(<ActionItemsPanel />);

    expect(screen.getByText("Book the room")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).toBeNull();
  });

  it("allows the empty message once the request settles successfully with nothing", () => {
    queryState = "success";

    render(<ActionItemsPanel />);

    expect(screen.getByText("Nothing on your list")).toBeInTheDocument();
  });
});
