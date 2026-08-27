import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

/**
 * The thing that notices a meeting has finished, wherever you happen to be.
 *
 * <p><b>It draws nothing.</b> There was a docked bar in the bottom-right corner
 * carrying a title and a percentage, and it was removed on request: a meeting
 * being processed already says so in its row on Home and in the banner on its
 * own page, so the card was a third copy of the same fact floating over
 * whatever was being read — and a job that never reached a terminal status sat
 * there for the life of the tab, including over a new recording in progress.
 *
 * <p>What is under test is what could not go with it. The completion toast and
 * the cache invalidation that stops Home listing a finished meeting as still
 * processing have to be owned by something mounted on every route, or they only
 * fire when you are already looking at the meeting. That used to be
 * `useSaveJob`, which meant an imported file got neither.
 *
 * <p>So every test here is a pair: nothing is rendered, and the job is settled
 * anyway.
 */
const { invalidateTags, dispatch, toastSuccess, toastError, meeting } = vi.hoisted(() => ({
  invalidateTags: vi.fn((tags: unknown) => ({ type: "invalidate", tags })),
  dispatch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  meeting: { current: undefined as unknown },
}));

let emit: ((e: unknown) => void) | null = null;
const deactivate = vi.fn();

vi.mock("@/lib/hooks", () => ({ useAppDispatch: () => dispatch }));
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

import { ProcessingDock } from "@/components/processing-dock";
import {
  trackProcessing,
  processingJobs,
  resetProcessingJobs,
} from "@/lib/processing-jobs";

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
  meeting.current = { id: "mtg_9", title: "Standup", status: "TRANSCRIBING" };
  resetProcessingJobs();
});

async function stage(status: string, progress = 50, message = "") {
  await waitFor(() => expect(emit).not.toBeNull());
  await act(async () => {
    emit!({ meetingId: "mtg_9", status, progress, message });
  });
}

describe("the processing watcher", () => {
  it("puts nothing on screen when this tab is watching no jobs", () => {
    const { container } = render(<ProcessingDock />);

    expect(container).toBeEmptyDOMElement();
  });

  it("puts nothing on screen when it is watching one", () => {
    // The whole of the change. No card, no bar, no dismiss button, nowhere.
    trackProcessing("mtg_9");

    const { container } = render(<ProcessingDock />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("puts nothing on screen when it is watching several", () => {
    trackProcessing("mtg_9");
    trackProcessing("mtg_8");

    const { container } = render(<ProcessingDock />);

    expect(container).toBeEmptyDOMElement();
  });

  it("says so when a meeting is ready, and carries the way back", async () => {
    // It arrives while you are somewhere else, so a toast with no way into the
    // meeting is a notification you have to go and act on from memory.
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    expect(toastSuccess).toHaveBeenCalledWith(
      '"Standup" is ready.',
      expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }),
    );
  });

  it("says so when a meeting fails, with the reason the server gave", async () => {
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
      'Processing failed for "Standup".',
      { description: "The audio could not be decoded." },
    );
  });

  it("refreshes the list Home renders from", async () => {
    // The reason this cannot simply be deleted. Without it a finished meeting
    // goes on reading "Processing" in a list nobody happened to refetch.
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    expect(invalidateTags).toHaveBeenCalledWith([{ type: "Meeting", id: "mtg_9" }, "Meetings"]);
  });

  it("lets go of a job once it has settled", async () => {
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    await waitFor(() => expect(processingJobs()).not.toContain("mtg_9"));
  });

  it("announces a finished meeting exactly once", async () => {
    // Settling untracks, which unmounts the watcher; without the guard a
    // re-render in the same tick fires the toast twice.
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);
    await stage("READY", 100);

    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("settles a meeting that finishes on the poll alone", async () => {
    // A proxy that drops the WebSocket leaves the socket silent for ever. The
    // poll is what makes the job finish rather than being watched all day.
    meeting.current = { id: "mtg_9", title: "Standup", status: "READY" };
    trackProcessing("mtg_9");

    render(<ProcessingDock />);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(processingJobs()).not.toContain("mtg_9");
  });

  it("closes the socket when it stops watching", async () => {
    trackProcessing("mtg_9");
    render(<ProcessingDock />);

    await stage("READY", 100);

    await waitFor(() => expect(deactivate).toHaveBeenCalled());
  });
});
