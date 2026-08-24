import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionItemComment, ActionItemResponse } from "@/lib/types";

/**
 * One action item.
 *
 * <p>The tests fall into two groups. One is about not losing work — a tick, a
 * retitle and a note all have to reach the server as the narrowest change that
 * expresses them, because a row that sends its whole state back can undo an edit
 * made in another tab. The other is about not lying: a deadline nobody could
 * parse must show the words that were said, and a sentence that could not be
 * placed in the recording must not offer to play it.
 */
const { patch, addComment, deleteComment, deleteItem, commentsAskedFor } = vi.hoisted(() => ({
  patch: vi.fn(),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  deleteItem: vi.fn(),
  // Hoisted with the mocks: the module factory reads it, and the factory runs
  // during the import below, before a plain `let` at this level exists.
  commentsAskedFor: [] as string[],
}));

let comments: ActionItemComment[];

vi.mock("@/lib/api", () => ({
  usePatchActionItemMutation: () => [
    (arg: unknown) => {
      patch(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useDeleteActionItemMutation: () => [
    (arg: unknown) => {
      deleteItem(arg);
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
  useGetActionItemCommentsQuery: (id: string) => {
    commentsAskedFor.push(id);
    return { data: comments, isLoading: false };
  },
  useAddActionItemCommentMutation: () => [
    (arg: unknown) => {
      addComment(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useDeleteActionItemCommentMutation: () => [
    (arg: unknown) => {
      deleteComment(arg);
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ActionItemRow } from "@/components/action-item-row";

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
    status: "OPEN",
    sourceSentence: "Priya will finish the JWT validation by Friday.",
    sourceStartSeconds: 942,
    edited: false,
    commentCount: 0,
    ...over,
  };
}

/** The body of the most recent PATCH. */
function lastPatch() {
  return (patch.mock.calls.at(-1)?.[0] as { body: Record<string, unknown> })?.body;
}

async function expand(row: ActionItemResponse = item(), props = {}) {
  render(<ActionItemRow item={row} {...props} />);
  await userEvent.click(screen.getByRole("button", { name: /Show details/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  comments = [];
  commentsAskedFor.length = 0;
});

describe("ActionItemRow completing", () => {
  it("ticks off without opening anything", async () => {
    render(<ActionItemRow item={item()} />);

    await userEvent.click(screen.getByRole("checkbox", { name: /Mark .* complete/ }));

    await waitFor(() => expect(lastPatch()).toEqual({ status: "DONE" }));
  });

  it("unticks back to open", async () => {
    render(<ActionItemRow item={item({ status: "DONE" })} />);

    await userEvent.click(screen.getByRole("checkbox", { name: /Mark .* complete/ }));

    await waitFor(() => expect(lastPatch()).toEqual({ status: "OPEN" }));
  });

  it("keeps a finished item visible rather than removing it", () => {
    render(<ActionItemRow item={item({ status: "DONE" })} />);

    // A list that empties as you work makes the work look like it never
    // happened, and "did we ever do that" is a question people ask.
    expect(screen.getByText("Finish the JWT validation")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Mark .* complete/ })).toBeChecked();
  });
});

describe("ActionItemRow deadline", () => {
  it("says how late it is", () => {
    render(<ActionItemRow item={item()} />);
    expect(screen.getByText("2 days late")).toBeInTheDocument();
  });

  it("keeps the words that were said alongside the date we read from them", () => {
    render(<ActionItemRow item={item()} />);

    // The promise was "Friday". Replacing it silently with a calendar date is
    // putting words in somebody's mouth.
    expect(screen.getByText("2 days late")).toHaveAttribute("title", "Said: “friday”");
  });

  it("shows an unreadable deadline verbatim", () => {
    render(
      <ActionItemRow
        item={item({ dueDate: "before the demo", dueOn: null, dueStatus: "NONE", daysUntilDue: null })}
      />,
    );

    expect(screen.getByText("due before the demo")).toBeInTheDocument();
  });
});

describe("ActionItemRow source", () => {
  it("offers to play the sentence where the promise was made", async () => {
    const onOpenSource = vi.fn();
    await expand(item(), { onOpenSource });

    await userEvent.click(screen.getByRole("button", { name: /15:42/ }));

    expect(onOpenSource).toHaveBeenCalledWith(942);
  });

  it("links into the meeting at that moment when there is no player here", async () => {
    await expand();

    expect(screen.getByRole("link", { name: /15:42/ })).toHaveAttribute(
      "href",
      "/meetings/mtg_1?t=942",
    );
  });

  it("offers nothing when the sentence could not be placed", async () => {
    await expand(item({ sourceStartSeconds: null }));

    // A link that seeks to the wrong moment plays somebody saying something
    // else, which reads as the evidence being made up.
    expect(screen.queryByRole("link", { name: /:/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Priya will finish the JWT validation/)).toBeInTheDocument();
  });
});

describe("ActionItemRow editing", () => {
  it("saves a corrected title", async () => {
    await expand();

    const title = screen.getByLabelText("What needs to happen");
    await userEvent.clear(title);
    await userEvent.type(title, "Finish JWT validation");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(lastPatch()).toMatchObject({ title: "Finish JWT validation" }),
    );
  });

  it("will not save an empty title", async () => {
    await expand();

    await userEvent.clear(screen.getByLabelText("What needs to happen"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // A task with no title is a row nobody can act on and nobody can find.
    expect(patch).not.toHaveBeenCalled();
  });

  it("offers no priority to set", async () => {
    await expand();

    // Gone in V54. It was three words guessed from a tone of voice, sitting in
    // a coloured badge beside a deadline somebody actually said out loud.
    // Asserted absent rather than deleted, because a badge is one line to add
    // back and adding it reads like a fix.
    expect(screen.queryByText(/priority/i)).not.toBeInTheDocument();
    for (const word of [/^high$/i, /^medium$/i, /^low$/i]) {
      expect(screen.queryByRole("button", { name: word })).not.toBeInTheDocument();
    }
  });

  it("clears a deadline with an empty string rather than a null", async () => {
    await expand();

    await userEvent.clear(screen.getByLabelText("Due"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // An absent field and an explicit empty one arrive identically; only the
    // empty string can mean "take it off".
    await waitFor(() => expect(lastPatch()).toMatchObject({ dueDate: "" }));
  });

  it("does not offer to save until something has changed", async () => {
    await expand();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("ActionItemRow notes", () => {
  it("does not fetch the log until the row is opened", () => {
    render(<ActionItemRow item={item()} />);

    // Fifty rows would otherwise be fifty requests for logs nobody read.
    expect(commentsAskedFor).toHaveLength(0);
  });

  it("logs a note against the task", async () => {
    await expand();

    await userEvent.type(screen.getByLabelText("Add a note"), "Waiting on legal.");
    await userEvent.click(screen.getByRole("button", { name: /Add note/ }));

    await waitFor(() =>
      expect(addComment).toHaveBeenCalledWith({ id: "ai_1", body: "Waiting on legal." }),
    );
  });

  it("shows what has been logged, oldest first", async () => {
    comments = [
      {
        id: "cmt_1",
        actionItemId: "ai_1",
        body: "Waiting on legal.",
        createdAt: "2026-08-14T09:00:00Z",
        updatedAt: "2026-08-14T09:00:00Z",
      },
    ];
    await expand();

    expect(screen.getByText("Waiting on legal.")).toBeInTheDocument();
  });

  it("calls them notes, not comments", async () => {
    await expand();

    // "Comment" promises a reply, and there is one account per workspace.
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText(/repl(y|ies)|mention/i)).not.toBeInTheDocument();
  });
});

describe("ActionItemRow translated", () => {
  const translated = {
    id: "ai_1",
    title: "Terminar la validación JWT",
    ownerName: "Priya",
    dueDate: "viernes",
    translated: true,
  };

  it("reads in the chosen language", () => {
    render(<ActionItemRow item={item()} translation={translated} />);

    expect(screen.getByText("Terminar la validación JWT")).toBeInTheDocument();
  });

  it("edits the original, and says so", async () => {
    render(<ActionItemRow item={item()} translation={translated} />);

    await userEvent.click(screen.getByRole("button", { name: /Show details/ }));

    // Typing a correction over a translation would save the translation as the
    // task, which nobody would notice until the next reader opened it.
    expect(screen.getByLabelText("What needs to happen")).toHaveValue("Finish the JWT validation");
    expect(screen.getByText(/Editing works on the original/)).toBeInTheDocument();
  });

  it("shows the original when the wording moved on since it was translated", () => {
    render(
      <ActionItemRow
        item={item()}
        translation={{ ...translated, title: "Finish the JWT validation", translated: false }}
      />,
    );

    expect(screen.getByText("Finish the JWT validation")).toBeInTheDocument();
    expect(screen.queryByText(/Editing works on the original/)).not.toBeInTheDocument();
  });
});

describe("ActionItemRow selection", () => {
  it("offers a separate control for selecting, distinct from completing", async () => {
    const onSelectedChange = vi.fn();
    render(<ActionItemRow item={item()} selectable onSelectedChange={onSelectedChange} />);

    await userEvent.click(screen.getByRole("checkbox", { name: /Select .*JWT/ }));

    expect(onSelectedChange).toHaveBeenCalledWith(true);
    // Selecting is not completing, and one control doing both is how a batch
    // gets ticked off by somebody who meant to look at it.
    expect(patch).not.toHaveBeenCalled();
  });

  it("offers no selection control where there is no bulk action", () => {
    render(<ActionItemRow item={item()} />);

    expect(screen.queryByRole("checkbox", { name: /Select/ })).not.toBeInTheDocument();
  });
});
