import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Insight } from "@/lib/types";

const add = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const unwrap = vi.fn(() => Promise.resolve({}));
let rows: Insight[] = [];

vi.mock("@/lib/api", () => ({
  useGetInsightsQuery: () => ({ data: rows, isLoading: false }),
  useAddInsightMutation: () => [
    (a: unknown) => {
      add(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
  useUpdateInsightMutation: () => [
    (a: unknown) => {
      update(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
  useDeleteInsightMutation: () => [
    (a: unknown) => {
      remove(a);
      return { unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { InsightsPanel } from "@/components/insights-panel";

/**
 * Decisions and risks on the meeting page.
 *
 * These rows are also handed to workspace chat as the authority on what was
 * agreed and when, so the editing path is not cosmetic — being able to correct
 * a row is what makes it safe to answer "does this conflict with what we
 * decided in March?" from the store.
 *
 * The split between the two kinds is the other thing worth pinning: a risk
 * rendered under Decisions is not a layout bug, it is a claim that the meeting
 * settled something it was actually worried about.
 */
function insight(over: Partial<Insight> = {}): Insight {
  return {
    id: "ins_1",
    meetingId: "mtg_1",
    kind: "DECISION",
    text: "Ship on the 14th.",
    sourceSection: "decisions",
    edited: false,
    createdAt: "2026-08-13T14:30:00Z",
    ...over,
  };
}

beforeEach(() => {
  add.mockClear();
  update.mockClear();
  remove.mockClear();
  rows = [];
});

describe("InsightsPanel", () => {
  it("puts each kind under its own heading", () => {
    rows = [
      insight({ id: "ins_1", kind: "DECISION", text: "Ship on the 14th." }),
      insight({ id: "ins_2", kind: "RISK", text: "The contract is unsigned.", sourceSection: "risks" }),
    ];
    render(<InsightsPanel meetingId="mtg_1" />);

    const decisions = screen.getByText("Decisions").closest("div[class*='rounded']")!;
    const risks = screen.getByText("Risks and blockers").closest("div[class*='rounded']")!;
    expect(decisions).toHaveTextContent("Ship on the 14th.");
    expect(decisions).not.toHaveTextContent("The contract is unsigned.");
    expect(risks).toHaveTextContent("The contract is unsigned.");
  });

  it("says an empty section is empty rather than showing nothing", () => {
    // An Interview meeting settles nothing. A blank card reads as a failure to
    // generate; a sentence reads as an accurate nothing.
    render(<InsightsPanel meetingId="mtg_1" />);
    expect(screen.getByText(/didn't settle anything/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was flagged/i)).toBeInTheDocument();
  });

  it("keeps a blocker distinguishable from a risk", () => {
    // Both store as RISK. Losing the section loses the difference between what
    // is already happening and what might.
    rows = [insight({ kind: "RISK", text: "Waiting on legal.", sourceSection: "blockers" })];
    render(<InsightsPanel meetingId="mtg_1" />);
    expect(screen.getByText("blocker")).toBeInTheDocument();
  });

  it("does not label a plain decision with its own section name", () => {
    rows = [insight()];
    render(<InsightsPanel meetingId="mtg_1" />);
    expect(screen.queryByText("decisions")).not.toBeInTheDocument();
  });

  it("saves an edit against the row's id", async () => {
    rows = [insight()];
    const user = userEvent.setup();
    render(<InsightsPanel meetingId="mtg_1" />);

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Ship on the 21st.{Enter}");

    expect(update).toHaveBeenCalledWith({
      id: "ins_1",
      meetingId: "mtg_1",
      text: "Ship on the 21st.",
    });
  });

  it("treats an emptied edit as a cancel", async () => {
    rows = [insight()];
    const user = userEvent.setup();
    render(<InsightsPanel meetingId="mtg_1" />);

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("Ship on the 14th.")).toBeInTheDocument();
  });

  it("adds a row under the kind whose card it was typed into", async () => {
    const user = userEvent.setup();
    render(<InsightsPanel meetingId="mtg_1" />);

    // Second "Add" is the risks card; a mix-up here files a risk as a decision.
    await user.click(screen.getAllByRole("button", { name: /Add/ })[1]);
    await user.type(screen.getByRole("textbox"), "Vendor may slip.{Enter}");

    expect(add).toHaveBeenCalledWith({
      meetingId: "mtg_1",
      kind: "RISK",
      text: "Vendor may slip.",
    });
  });

  it("deletes by id and meeting, so the right list refetches", async () => {
    rows = [insight()];
    const user = userEvent.setup();
    render(<InsightsPanel meetingId="mtg_1" />);

    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(remove).toHaveBeenCalledWith({ id: "ins_1", meetingId: "mtg_1" });
  });
});
