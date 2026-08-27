import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, renderHook } from "@testing-library/react";

/**
 * A meeting still being made, inside the row it already occupies.
 *
 * <p>Home said "Processing" and nothing else, so a job thirty seconds in looked
 * identical to one nearly done. What is added is the stage, a slim bar and a
 * percentage — in the same row, not in a separate section and not in a card of
 * its own, because a meeting has one place in this list and keeps it.
 *
 * <p>The status here is live from the socket, and that is not a detail: Home
 * does not poll its list, so without the subscription a row would freeze on
 * whatever the page load happened to see and go on claiming to be processing
 * long after it finished.
 */
let emit: ((e: unknown) => void) | null = null;
const deactivate = vi.fn();
const subscribe = vi.fn();

vi.mock("@/lib/ws", () => ({
  subscribeMeetingStatus: (id: string, handlers: { onEvent: (e: unknown) => void }) => {
    subscribe(id);
    emit = handlers.onEvent;
    return { deactivate };
  },
}));

import { ProcessingRow, useLiveMeetingStatus } from "@/components/processing-row";
import type { MeetingStatus } from "@/lib/types";

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
});

async function say(status: MeetingStatus, progress: number) {
  await waitFor(() => expect(emit).not.toBeNull());
  await act(async () => {
    emit!({ meetingId: "mtg_9", status, progress, message: "" });
  });
}

describe("the processing row", () => {
  it("names the stage rather than only drawing a bar", () => {
    render(<ProcessingRow meetingId="mtg_9" status="TRANSCRIBING" reported={5} />);

    expect(screen.getByText("Transcribing audio…")).toBeInTheDocument();
  });

  it("shows a percentage, in figures", () => {
    render(<ProcessingRow meetingId="mtg_9" status="SUMMARIZING" reported={64} />);

    expect(screen.getByText("64%")).toBeInTheDocument();
  });

  it("gives the bar the attributes a screen reader needs", () => {
    // Progress must not rely on the bar's width alone.
    render(<ProcessingRow meetingId="mtg_9" status="SUMMARIZING" reported={64} />);

    const bar = screen.getByRole("progressbar", { name: "Processing progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "64");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("moves to the next stage's words when the status moves", () => {
    const { rerender } = render(
      <ProcessingRow meetingId="mtg_9" status="TRANSCRIBING" reported={5} />,
    );
    expect(screen.getByText("Transcribing audio…")).toBeInTheDocument();

    rerender(<ProcessingRow meetingId="mtg_9" status="EXTRACTING" reported={90} />);

    expect(screen.getByText("Extracting action items…")).toBeInTheDocument();
  });
});

describe("the live status behind it", () => {
  it("opens no subscription for a meeting that is already finished", () => {
    // A list of a hundred finished meetings must not hold a hundred sockets.
    renderHook(() => useLiveMeetingStatus("mtg_9", "READY"));

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("subscribes for one that is still being made", () => {
    renderHook(() => useLiveMeetingStatus("mtg_9", "TRANSCRIBING"));

    expect(subscribe).toHaveBeenCalledWith("mtg_9");
  });

  it("prefers what the socket says over the cached row", async () => {
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));

    await say("SUMMARIZING", 60);

    expect(result.current.status).toBe("SUMMARIZING");
    expect(result.current.reported).toBe(60);
  });

  it("stops claiming to be processing the moment the socket says READY", async () => {
    // The list cache still says QUEUED and nothing refetched it. Without this
    // the row would keep its bar over a meeting that was ready.
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));

    await say("READY", 100);

    expect(result.current.status).toBe("READY");
  });

  it("lets go of its subscription when the row unmounts", () => {
    const { unmount } = renderHook(() => useLiveMeetingStatus("mtg_9", "TRANSCRIBING"));

    unmount();

    expect(deactivate).toHaveBeenCalled();
  });

  it("ignores an event about a different meeting", () => {
    // One socket topic per meeting, but a stray frame must not relabel this row.
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));

    act(() => {
      emit!({ meetingId: "mtg_OTHER", status: "READY", progress: 100, message: "" });
    });

    expect(result.current.status).toBe("QUEUED");
  });
});
