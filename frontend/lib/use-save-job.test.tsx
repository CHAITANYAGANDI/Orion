import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { UseRecorder } from "@/lib/use-recorder";

/**
 * Getting a recording onto the server, and following what happens to it.
 *
 * <p>This used to be tested through the control bar, which was testing the
 * buttons and the upload in one breath. The logic lives in a hook now — two
 * components draw it — so the wait is tested here and the buttons are tested
 * where they are.
 *
 * <p>Three things carry real weight. The percentage must only ever go up, and
 * must not claim to be finished before the meeting is: a bar at 100% beside
 * "Extracting…" is a finished job that is not. The phase must be put back on
 * every path, because it outlives the recording that set it and one left behind
 * makes the *next* recording open unusable. And the wait must be able to end
 * without the WebSocket, which is the difference between a slow finish and a
 * bar that never finishes at all.
 */
const {
  createUploadUrl,
  createMeeting,
  deleteMeeting,
  putWithProgress,
  toastError,
  toastSuccess,
  push,
  dispatch,
  invalidateTags,
  polled,
} =
  vi.hoisted(() => ({
    createUploadUrl: vi.fn(),
    createMeeting: vi.fn(),
    deleteMeeting: vi.fn(),
    putWithProgress: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    push: vi.fn(),
    dispatch: vi.fn(),
    invalidateTags: vi.fn((tags: unknown) => ({ type: "invalidate", tags })),
    polled: { current: undefined as unknown },
  }));

let emit: ((e: unknown) => void) | null = null;
const deactivate = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/hooks", () => ({ useAppDispatch: () => dispatch }));

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

vi.mock("@/lib/ws", () => ({
  subscribeMeetingStatus: (_id: string, handlers: { onEvent: (e: unknown) => void }) => {
    emit = handlers.onEvent;
    return { deactivate };
  },
}));

vi.mock("@/lib/uploads", async (orig) => ({
  ...(await orig<typeof import("@/lib/uploads")>()),
  putWithProgress: (url: string, f: File, onProgress: (n: number) => void) => {
    onProgress(100);
    return putWithProgress(url, f);
  },
}));

vi.mock("@/lib/api", () => ({
  api: { util: { invalidateTags } },
  useCreateUploadUrlMutation: () => [
    (arg: unknown) => {
      createUploadUrl(arg);
      return { unwrap: () => Promise.resolve({ uploadUrl: "https://s3/put", objectKey: "k1" }) };
    },
  ],
  useCreateMeetingMutation: () => [
    (arg: unknown) => {
      createMeeting(arg);
      return { unwrap: () => Promise.resolve({ id: "mtg_9", status: "QUEUED" }) };
    },
  ],
  useDeleteMeetingMutation: () => [
    (arg: unknown) => {
      deleteMeeting(arg);
      return { unwrap: () => Promise.resolve(undefined) };
    },
  ],
  useGetMeetingQuery: () => ({ data: polled.current }),
}));

import { useSaveJob, currentStep } from "@/lib/use-save-job";

const reset = vi.fn();

function aRecorder(state: UseRecorder["state"] = "stopped"): UseRecorder {
  return { state, reset } as unknown as UseRecorder;
}

function aResult(bytes = 2048) {
  return {
    file: new File(["x".repeat(bytes)], "recording-1.webm", { type: "audio/webm" }),
    durationSeconds: 90,
  };
}

function setup(state: UseRecorder["state"] = "stopped") {
  return renderHook(({ s }: { s: UseRecorder["state"] }) => useSaveJob(aRecorder(s)), {
    initialProps: { s: state },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
  polled.current = undefined;
  putWithProgress.mockResolvedValue(undefined);
});

async function stage(status: string, progress: number, message: string) {
  await waitFor(() => expect(emit).not.toBeNull());
  await act(async () => {
    emit!({ meetingId: "mtg_9", status, progress, message });
  });
}

describe("saving", () => {
  it("uploads, creates the meeting and starts watching it", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.save(aResult(), "Tuesday design review");
    });

    expect(createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "audio/webm" }),
    );
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Tuesday design review", recorded: true }),
    );
    expect(result.current.phase).toBe("processing");
    expect(result.current.job?.id).toBe("mtg_9");
  });

  it("leaves the recording page as soon as there is nothing left on it", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    // The audio has gone to the server and the microphone is closed. Staying
    // would be sitting on a page about a recording that is over; the wait
    // itself happens in the docked bar, which is on every page.
    expect(push).toHaveBeenCalledWith("/home");
  });

  it("lets go of the audio once the server has it", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    // Held in the tab as well, it is a second copy of an hour of audio that
    // nothing reads, and the bar would go on offering to save it.
    expect(reset).toHaveBeenCalled();
  });

  it("refuses a recording that captured nothing", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.save(aResult(0), "x");
    });

    expect(createUploadUrl).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("keeps the audio and comes back to idle when the upload fails", async () => {
    putWithProgress.mockRejectedValue(new Error("Upload failed (500)"));
    const { result } = setup();

    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    // The recording only exists in this tab. Clearing it on a failed upload
    // destroys the meeting to tidy up after an error the user could retry.
    expect(reset).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(toastError).toHaveBeenCalled();
  });
});

describe("the percentage", () => {
  it("counts the upload as the first third, then carries on from there", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await stage("TRANSCRIBING", 40, "Transcribing…");
    // 30 for the upload plus 70% of 40. A second bar starting again from zero
    // would read as the first half having been thrown away.
    expect(result.current.overallProgress).toBe(58);

    await stage("SUMMARIZING", 70, "Summarising…");
    expect(result.current.overallProgress).toBe(79);
  });

  it("does not reach 100 until the meeting is actually ready", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    // The worker reports 100 on its last stage, before the result lands. A bar
    // at 100% beside "Extracting…" is a finished job that is not.
    await stage("EXTRACTING", 100, "Extracting decisions…");
    expect(result.current.overallProgress).toBe(99);
  });
});

describe("following the work", () => {
  it("moves through the stages", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await stage("TRANSCRIBING", 40, "Generating transcript from audio…");
    expect(result.current.label).toBe("Generating transcript from audio…");
    expect(currentStep(result.current.phase, result.current.job?.status)).toBe("transcribe");

    await stage("SUMMARIZING", 70, "Writing the brief…");
    expect(currentStep(result.current.phase, result.current.job?.status)).toBe("summarise");
  });

  it("finishes even when the socket never says anything", async () => {
    const { result, rerender } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    // The poll is the whole reason this works. A dropped WebSocket otherwise
    // leaves the bar on one number over a meeting ready minutes ago.
    polled.current = { id: "mtg_9", status: "READY" };
    await act(async () => {
      rerender({ s: "idle" });
    });

    await waitFor(() => expect(result.current.job).toBeNull());
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("drops the mid-pipeline snapshot before opening the meeting", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await stage("READY", 100, "Ready.");

    // The poll fills the meeting cache with whatever it last saw, and Home
    // lists from that same cache — so without this the finished meeting sits in
    // the list marked "Transcribing" until something else happens to refetch.
    expect(invalidateTags).toHaveBeenCalledWith([{ type: "Meeting", id: "mtg_9" }, "Meetings"]);
    expect(dispatch).toHaveBeenCalled();
  });

  it("clears itself when the work is done, and goes nowhere", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });
    push.mockClear();

    await stage("READY", 100, "Meeting brief ready.");

    // Home is already showing the meeting in its list, which is where somebody
    // would have gone looking. Being thrown onto the meeting page takes the
    // choice away from anyone who saved a recording and moved on.
    expect(push).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.job).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith("Your meeting is ready.");
  });

  it("settles once, not again when the state is cleared", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await stage("READY", 100, "Ready.");
    await act(async () => {});

    // Clearing the phase this fires on looks like a state change. Guarded by
    // meeting id, or the whole thing runs a second time.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("reports a failure with the reason the server gave", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await stage("FAILED", 0, "The audio could not be decoded.");

    // Nothing navigates, so the toast is the only thing that says so. The
    // meeting is in the Home list carrying the same failure.
    expect(toastError).toHaveBeenCalledWith("The audio could not be decoded.");
    expect(result.current.job).toBeNull();
  });
});

describe("stopping", () => {
  it("deletes the meeting, because the worker cannot be recalled", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(deleteMeeting).toHaveBeenCalledWith("mtg_9");
    expect(result.current.phase).toBe("idle");
    expect(result.current.job).toBeNull();
  });

  it("stays put when the delete fails, since it may have finished", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });
    deleteMeeting.mockImplementationOnce(() => {
      throw new Error("gone");
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(toastError).toHaveBeenCalled();
    expect(result.current.job).not.toBeNull();
  });
});

describe("what the next recording inherits", () => {
  it("is nothing, once the last one has been dismissed", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });
    await stage("READY", 100, "Ready.");

    act(() => result.current.dismiss());

    // The bug this is here for: `phase` outlives the recording that set it, and
    // one left at "creating" made the next recording open already busy — Save
    // disabled and reading "Working…", Discard not rendered at all.
    expect(result.current.phase).toBe("idle");
    expect(result.current.job).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("is nothing when a new recording simply starts", async () => {
    const { result, rerender } = setup();
    await act(async () => {
      await result.current.save(aResult(), "x");
    });
    await stage("READY", 100, "Ready.");

    // Pressing Record is the clearest possible statement that the last one has
    // been dealt with.
    await act(async () => {
      rerender({ s: "recording" });
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.job).toBeNull();
  });
});
