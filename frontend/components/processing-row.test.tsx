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
 * <p>The status here comes from the socket <em>and</em> a poll, and that is not
 * a detail. A stage event is a push with no replay: the row mounts, SockJS
 * handshakes, STOMP subscribes, and everything the worker emitted in between
 * went to nobody. On a short recording the job can be over by then, which left
 * the bar stuck at 4% -- the ceiling of the QUEUED band -- on a meeting that
 * finished perfectly well. The poll is the floor under that.
 */
let emit: ((e: unknown) => void) | null = null;
const deactivate = vi.fn();
const subscribe = vi.fn();

/** What the poll currently reports, or nothing at all. */
let polled: MeetingStatus | undefined;
const query = vi.fn();

vi.mock("@/lib/api", () => ({
  useGetMeetingQuery: (id: string, options: { skip?: boolean }) => {
    query(id, options);
    return { data: polled ? { status: polled } : undefined };
  },
}));

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
  polled = undefined;
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

describe("the poll under the socket", () => {
  it("moves the row for a status the socket never delivered", () => {
    // The bug, exactly: the subscription was established after the worker had
    // already reported TRANSCRIBING, so nothing was ever pushed. Before the
    // poll the row sat on QUEUED, whose band tops out at 4%.
    polled = "TRANSCRIBING";
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));

    expect(result.current.status).toBe("TRANSCRIBING");
  });

  it("keeps the socket's answer when the socket is ahead", async () => {
    // The poll is the floor, not the primary. A push arriving within a second
    // must not wait up to five for a request to agree with it.
    polled = "QUEUED";
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));
    await say("SUMMARIZING", 60);

    expect(result.current.status).toBe("SUMMARIZING");
    expect(result.current.reported).toBe(60);
  });

  it("a lagging poll cannot walk the row backwards", async () => {
    // A request already in flight when a stage event lands answers with the
    // older status a moment later. "Whichever spoke last" would rewind the row.
    const { result, rerender } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));
    await say("SUMMARIZING", 60);
    polled = "TRANSCRIBING";
    rerender();

    expect(result.current.status).toBe("SUMMARIZING");
  });

  it("drops the socket's percentage when the poll is the one being shown", async () => {
    // A progress number belongs to the status it was reported for. Carrying it
    // over would clamp the bar into a band it no longer occupies.
    const { result, rerender } = renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));
    await say("TRANSCRIBING", 30);
    polled = "EXTRACTING";
    rerender();

    expect(result.current.status).toBe("EXTRACTING");
    expect(result.current.reported).toBeUndefined();
  });

  it("a terminal status ends the job however it arrives", () => {
    polled = "READY";
    const { result } = renderHook(() => useLiveMeetingStatus("mtg_9", "TRANSCRIBING"));

    expect(result.current.status).toBe("READY");
  });

  it("a finished meeting neither subscribes nor polls", () => {
    renderHook(() => useLiveMeetingStatus("mtg_9", "READY"));

    expect(subscribe).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("mtg_9", expect.objectContaining({ skip: true }));
  });

  it("polls often enough to see a short stage", () => {
    // A stage on a brief recording can last ten seconds. Polling slower than
    // that reintroduces the bug by a slower route.
    renderHook(() => useLiveMeetingStatus("mtg_9", "QUEUED"));

    const [, options] = query.mock.calls[0];
    expect(options.pollingInterval).toBeLessThanOrEqual(5_000);
    expect(options.skip).toBe(false);
  });
});
