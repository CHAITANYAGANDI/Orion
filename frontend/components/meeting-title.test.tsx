import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const update = vi.fn();
const unwrap = vi.fn(() => Promise.resolve({}));

vi.mock("@/lib/api", () => ({
  useUpdateMeetingMutation: () => [
    (args: unknown) => {
      update(args);
      return { unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MeetingTitle, MeetingTags } from "@/components/meeting-title";

/**
 * Renaming and tagging a meeting.
 *
 * Uploading collects neither any more, so this is the only place either is set.
 * That raises the stakes on the quiet failures: a rename that saves an empty
 * string leaves a meeting no one can find in a list, and a tag edit that sends
 * a stale local list silently drops whichever tags were added in between.
 */
beforeEach(() => {
  update.mockClear();
  unwrap.mockClear();
});

describe("MeetingTitle", () => {
  it("shows the title until asked to edit", () => {
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    expect(screen.getByRole("heading", { name: "Acme kickoff" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("saves a new title on Enter", async () => {
    const user = userEvent.setup();
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Acme renewal{Enter}");

    expect(update).toHaveBeenCalledWith({ id: "mtg_1", body: { title: "Acme renewal" } });
  });

  it("sends only the title, never the tags", async () => {
    // Both fields share an endpoint. Sending both would let an unrelated
    // in-progress tag edit ride along with a rename.
    const user = userEvent.setup();
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Renamed{Enter}");

    const body = update.mock.calls[0][0].body;
    expect(Object.keys(body)).toEqual(["title"]);
  });

  it("treats an emptied box as a cancel, not as a rename to nothing", async () => {
    // A meeting with a blank title is unfindable in every list that shows it.
    const user = userEvent.setup();
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Acme kickoff" })).toBeInTheDocument();
  });

  it("does not save an unchanged title", async () => {
    const user = userEvent.setup();
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    await user.keyboard("{Enter}");
    expect(update).not.toHaveBeenCalled();
  });

  it("discards the draft on Escape", async () => {
    const user = userEvent.setup();
    render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    await user.type(screen.getByRole("textbox"), " and more");
    await user.keyboard("{Escape}");

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Acme kickoff" })).toBeInTheDocument();
  });

  it("follows the prop when the title changes elsewhere", () => {
    // A reprocess or a rename in another tab must not be overwritten by a
    // draft left behind from a previous edit.
    const { rerender } = render(<MeetingTitle id="mtg_1" title="Acme kickoff" />);
    rerender(<MeetingTitle id="mtg_1" title="Acme renewal" />);
    expect(screen.getByRole("heading", { name: "Acme renewal" })).toBeInTheDocument();
  });
});

describe("MeetingTags", () => {
  it("sends the whole list when adding, built from the current props", async () => {
    // The endpoint takes a list, not a delta. Reading from props each time is
    // what stops two quick edits producing a list that never existed.
    const user = userEvent.setup();
    render(<MeetingTags id="mtg_1" tags={["sales"]} />);
    await user.click(screen.getByRole("button", { name: /Tag/ }));
    await user.type(screen.getByRole("textbox"), "q3{Enter}");

    expect(update).toHaveBeenCalledWith({ id: "mtg_1", body: { tags: ["sales", "q3"] } });
  });

  it("removes a tag by sending the list without it", async () => {
    const user = userEvent.setup();
    render(<MeetingTags id="mtg_1" tags={["sales", "q3"]} />);
    await user.click(screen.getByRole("button", { name: "Remove tag sales" }));

    expect(update).toHaveBeenCalledWith({ id: "mtg_1", body: { tags: ["q3"] } });
  });

  it("sends an empty list when the last tag goes", async () => {
    // Null would mean "leave them alone", so removing the last tag has to send
    // an empty array or it silently does nothing.
    const user = userEvent.setup();
    render(<MeetingTags id="mtg_1" tags={["sales"]} />);
    await user.click(screen.getByRole("button", { name: "Remove tag sales" }));

    expect(update).toHaveBeenCalledWith({ id: "mtg_1", body: { tags: [] } });
  });

  it("ignores a tag that only differs by case", async () => {
    // "Sales" and "sales" filter to the same meetings, so two rows would split
    // one tag into a pair that look identical in a list.
    const user = userEvent.setup();
    render(<MeetingTags id="mtg_1" tags={["sales"]} />);
    await user.click(screen.getByRole("button", { name: /Tag/ }));
    await user.type(screen.getByRole("textbox"), "Sales{Enter}");

    expect(update).not.toHaveBeenCalled();
  });

  it("ignores an empty tag", async () => {
    const user = userEvent.setup();
    render(<MeetingTags id="mtg_1" tags={[]} />);
    await user.click(screen.getByRole("button", { name: /Tag/ }));
    await user.keyboard("{Enter}");

    expect(update).not.toHaveBeenCalled();
  });
});
