import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The wait, following you around.
 *
 * <p>The complaint this answers was "transcribing should carry on in the
 * background even when I am not on that page". It always did — the ai-service
 * consumes from Kafka and never checks whether a browser is open — but the
 * interface said otherwise: the meeting's page was a full-width progress card
 * with nothing else on it, and leaving lost sight of the job entirely.
 *
 * <p>So this is the piece that makes leaving free, and the things it owes are:
 * it keeps showing the job across a navigation, it says when the job is done
 * wherever you happen to be, and it invalidates the caches Home lists from so a
 * finished meeting stops reading "Transcribing" in a list nobody refetched.
 * That last one used to belong to `useSaveJob`, which meant an imported file
 * never got it.
 */
const { invalidateTags, dispatch, toastSuccess, toastError, meeting, usePathnameMock } =
  vi.hoisted(() => ({
  invalidateTags: vi.fn((tags: unknown) => ({ type: "invalidate", tags })),
  dispatch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  meeting: { current: undefined as unknown },
  usePathnameMock: vi.fn(() => "/ask"),
}));

let emit: ((e: unknown) => void) | null = null;
const deactivate = vi.fn();

vi.mock("@/lib/hooks", () => ({ useAppDispatch: () => dispatch }));
vi.mock("next/navigation", () => ({ usePathname: usePathnameMock }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@/lib/ws", () => ({
  subscribeMeetingStatus: (_id: string, handlers: { onEvent: (e: unknown) => void }) => {
    emit = handlers.onEvent;
    return { deactivate };
  },
}));
vi.mock("@/lib/api", () => ({
  api: { util: { invalidateTags } },
  useGetMeetingQuery: () => ({ data: meeting.current }),
}));

import { ProcessingDock, visibleJobs } from "@/components/processing-dock";
import {
  trackProcessing,
  processingJobs,
  resetProcessingJobs,
} from "@/lib/processing-jobs";

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
  meeting.current = { id: "mtg_9", title: "Standup", status: "TRANSCRIBING" };
  // Somewhere that is neither Home nor a meeting page, so the existing tests
  // below see the dock they were written against.
  usePathnameMock.mockReturnValue("/ask");
  resetProcessingJobs();
});

async function stage(status: string, progress = 50, message = "") {
  await waitFor(() => expect(emit).not.toBeNull());
  await act(async () => {
    emit!({ meetingId: "mtg_9", status, progress, message });
  });
}

describe("ProcessingDock", () => {
  it("draws nothing at all when this tab is watching no jobs", () => {
    const { container } = render(<ProcessingDock />);

    // Not an empty box in the corner of every page in the app.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the meeting it is watching, by name", () => {
    trackProcessing("mtg_9");

    render(<ProcessingDock />);

    expect(screen.getByText("Standup")).toBeInTheDocument();
  });

  it("says the work carries on without you", () => {
    // The whole point. A bar that only showed a percentage would leave the
    // original misunderstanding exactly where it was.
    trackProcessing("mtg_9");

    render(<ProcessingDock />);

    expect(screen.getByText(/keeps going if you leave/i)).toBeInTheDocument();
  });

  it("links to the meeting, so the bar is a way back to it", () => {
    trackProcessing("mtg_9");

    render(<ProcessingDock />);

    expect(screen.getByRole("link", { name: "Standup" })).toHaveAttribute(
      "href",
      "/meetings/mtg_9",
    );
  });

  it("announces a finished meeting and stops watching it", async () => {
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    expect(toastSuccess).toHaveBeenCalled();
    // Dropped from the store, so the card goes with it rather than sitting at
    // 100% under a toast that already said so.
    await waitFor(() => expect(processingJobs()).not.toContain("mtg_9"));
  });

  it("refetches the lists a finished meeting appears in", async () => {
    // The poll filled the meeting cache with a mid-pipeline snapshot, and Home
    // lists from that same cache — so without this the finished meeting sits in
    // the list marked "Transcribing" until something else happens to refetch.
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    expect(invalidateTags).toHaveBeenCalledWith([{ type: "Meeting", id: "mtg_9" }, "Meetings"]);
    expect(dispatch).toHaveBeenCalled();
  });

  it("reports a failure with the reason the server gave", async () => {
    meeting.current = {
      id: "mtg_9",
      title: "Standup",
      status: "TRANSCRIBING",
      errorMessage: "The audio could not be decoded.",
    };
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("FAILED", 100);

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Standup"),
      expect.objectContaining({ description: "The audio could not be decoded." }),
    );
  });

  it("announces once, not again on the next render", async () => {
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);
    await act(async () => {});

    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("finishes on the poll when the socket never says anything", async () => {
    // A browser or proxy that drops the WebSocket leaves the socket silent, and
    // a dock that trusted it alone would sit at one number over a meeting that
    // was ready ten minutes ago.
    trackProcessing("mtg_9");
    const { rerender } = render(<ProcessingDock />);

    meeting.current = { id: "mtg_9", title: "Standup", status: "READY" };
    await act(async () => {
      rerender(<ProcessingDock />);
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(processingJobs()).not.toContain("mtg_9");
  });

  it("can be dismissed without anything being cancelled", async () => {
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await userEvent.click(screen.getByRole("button", { name: /Stop showing this/i }));

    // Stops watching. It cannot stop the worker — that is what deleting the
    // meeting does, and it is offered on the meeting's own page where the
    // consequence can be spelled out.
    expect(processingJobs()).not.toContain("mtg_9");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("watches several meetings at once", () => {
    trackProcessing("mtg_9");
    trackProcessing("mtg_8");

    render(<ProcessingDock />);

    // Two cards, not one showing the most recent. Importing three files in a
    // row is three jobs and the user is owed all three.
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});

/**
 * The rule that stops one job drawing two bars.
 *
 * <p>The complaint was seeing "a large processing indicator in the meeting page
 * AND a floating bottom-right processing card" for the same meeting. The dock
 * is the one that yields, because the inline banner is attached to the thing it
 * is about; and on Home it yields entirely, because every processing meeting is
 * already saying so inside its own row.
 */
describe("where the dock is allowed to draw", () => {
  it("drops the meeting whose page is on screen", () => {
    expect(visibleJobs(["mtg_9", "mtg_8"], "/meetings/mtg_9")).toEqual(["mtg_8"]);
  });

  it("still shows other meetings while one is being viewed", () => {
    // They are not on screen anywhere else, so hiding them would lose them.
    expect(visibleJobs(["mtg_8"], "/meetings/mtg_9")).toEqual(["mtg_8"]);
  });

  it("draws nothing at all on Home", () => {
    // Home communicates processing through the meeting row itself.
    expect(visibleJobs(["mtg_9", "mtg_8"], "/home")).toEqual([]);
  });

  it("still draws everywhere else", () => {
    expect(visibleJobs(["mtg_9"], "/ask")).toEqual(["mtg_9"]);
    expect(visibleJobs(["mtg_9"], "/folder/prj_1")).toEqual(["mtg_9"]);
  });

  it("is not confused by a sub-route of the meeting page", () => {
    expect(visibleJobs(["mtg_9"], "/meetings/mtg_9/anything")).toEqual([]);
  });

  it("does not match a different meeting whose id starts the same", () => {
    // A prefix compare would hide mtg_9 while viewing mtg_99.
    expect(visibleJobs(["mtg_9"], "/meetings/mtg_99")).toEqual(["mtg_9"]);
  });

  it("draws everything when the pathname is not known yet", () => {
    // `usePathname` is null on the server pass; the safe answer is the dock the
    // user already expects rather than a blank corner.
    expect(visibleJobs(["mtg_9"], "")).toEqual(["mtg_9"]);
  });
});

it("renders nothing for the meeting currently being viewed", () => {
  usePathnameMock.mockReturnValue("/meetings/mtg_9");
  trackProcessing("mtg_9");

  const { container } = render(<ProcessingDock />);

  // Exactly one processing UI in this view, and it is the page's own banner.
  //
  // Asserted on what is drawn rather than on an empty container: the job is
  // still mounted and still being watched -- that is the point, and hiding it
  // by unmounting is the bug this replaced. The wrapper collapses via
  // `empty:hidden`.
  expect(container.textContent).toBe("");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

/**
 * Hidden is not the same as unwatched.
 *
 * <p>The bug: the dock returned null when there was nothing to draw, which also
 * unmounted the watcher — no poll, no toast, no cache invalidation. A meeting
 * that finished while the user sat on Home was never noticed, so its row went on
 * saying "Processing" over a meeting that was ready.
 */
describe("watching where it does not draw", () => {
  it("still settles a meeting that finishes while the user is on Home", async () => {
    usePathnameMock.mockReturnValue("/home");
    trackProcessing("mtg_9");
    const { container } = render(<ProcessingDock />);

    // Nothing on screen — Home says it in the row.
    expect(container.textContent).toBe("");

    await stage("READY", 100);

    // But the job was watched all along: the list Home renders from is
    // refetched, which is what stops the row claiming to still be processing.
    expect(invalidateTags).toHaveBeenCalledWith([{ type: "Meeting", id: "mtg_9" }, "Meetings"]);
    await waitFor(() => expect(processingJobs()).not.toContain("mtg_9"));
  });

  it("still settles the meeting whose own page is open", async () => {
    // The page has its own banner and its own poll, but the tracker must still
    // let go of the job — otherwise it is watched for the life of the tab.
    usePathnameMock.mockReturnValue("/meetings/mtg_9");
    trackProcessing("mtg_9");
    const { container } = render(<ProcessingDock />);

    expect(container.textContent).toBe("");

    await stage("READY", 100);

    await waitFor(() => expect(processingJobs()).not.toContain("mtg_9"));
  });

  it("draws the visible one and only watches the rest", async () => {
    usePathnameMock.mockReturnValue("/meetings/mtg_9");
    trackProcessing("mtg_9");
    trackProcessing("mtg_8");

    render(<ProcessingDock />);

    // One card: the meeting being viewed says it on its own page.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
