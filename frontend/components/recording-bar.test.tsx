import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The docked recording controls.
 *
 * <p>Three things are being held down here. The bar has to be absent when there
 * is nothing to control, because a permanent strip across the bottom of every
 * page implies a live microphone and is the sort of chrome nobody can dismiss.
 *
 * <p>The no-audio warning has to be tied to the thing it claims — a recording
 * that is running and receiving nothing. Shown while paused it would report the
 * user's own choice as a fault; shown instantly it would fire in every gap in
 * the conversation and be ignored by the time it mattered.
 *
 * <p>And saving has to assert consent, because the tick that gated the start of
 * the recording lives on a page that unmounts the moment somebody navigates
 * away. Reading a checkbox at save time would file half the meetings in the
 * product as "not asserted" for no reason but a route change.
 */
const {
  createUploadUrl,
  createMeeting,
  updatePreferences,
  push,
  toastError,
  toastSuccess,
  putWithProgress,
} = vi.hoisted(() => ({
  createUploadUrl: vi.fn(),
  createMeeting: vi.fn(),
  updatePreferences: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  putWithProgress: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

vi.mock("@/lib/uploads", async (orig) => ({
  ...(await orig<typeof import("@/lib/uploads")>()),
  putWithProgress: (url: string, f: File, onProgress: (n: number) => void) => {
    onProgress(100);
    return putWithProgress(url, f);
  },
}));

vi.mock("@/lib/api", () => ({
  useCreateUploadUrlMutation: () => [
    (arg: unknown) => {
      createUploadUrl(arg);
      return { unwrap: () => Promise.resolve({ uploadUrl: "https://s3/put", objectKey: "k1" }) };
    },
  ],
  useCreateMeetingMutation: () => [
    (arg: unknown) => {
      createMeeting(arg);
      return { unwrap: () => Promise.resolve({ id: "mtg_9" }) };
    },
  ],
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", nativeName: "English", rightToLeft: false },
      { code: "es", name: "Spanish", nativeName: "Español", rightToLeft: false },
    ],
  }),
  useGetPreferencesQuery: () => ({ data: { defaultLanguage: null, displayName: "Sam" } }),
  useUpdatePreferencesMutation: () => [
    (arg: unknown) => {
      updatePreferences(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
  ],
}));

const recorder = vi.hoisted(() => ({ current: null as unknown }));
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/recording-context", () => ({
  useRecording: () => recorder.current,
  useRecordingSession: () => session.current,
}));

import { RecordingBar } from "@/components/recording-bar";
import type { UseRecorder } from "@/lib/use-recorder";
import type { UseLiveTranscript } from "@/lib/use-live-transcript";
import type { RecordingSession } from "@/lib/recording-context";

const pause = vi.fn();
const resume = vi.fn();
const stop = vi.fn();
const reset = vi.fn();
const setDeviceId = vi.fn();
const setTitle = vi.fn();

function aTranscript(overrides: Partial<UseLiveTranscript> = {}): UseLiveTranscript {
  return {
    supported: true,
    phrases: [],
    interim: "",
    error: null,
    clear: vi.fn(),
    ...overrides,
  };
}

function aRecorder(overrides: Partial<UseRecorder> = {}): UseRecorder {
  return {
    state: "recording",
    elapsed: 9,
    startedAt: new Date("2026-08-16T03:04:00"),
    level: 0.4,
    silentSeconds: 0,
    error: null,
    result: null,
    supported: true,
    devices: [],
    deviceId: null,
    setDeviceId,
    start: vi.fn(),
    pause,
    resume,
    stop,
    reset,
    ...overrides,
  };
}

function renderBar(
  overrides: Partial<UseRecorder> = {},
  sessionOverrides: Partial<RecordingSession> = {},
) {
  recorder.current = aRecorder(overrides);
  session.current = {
    title: "",
    setTitle,
    transcript: aTranscript(),
    ...sessionOverrides,
  } satisfies RecordingSession;
  return render(<RecordingBar />);
}

function aResult(): UseRecorder["result"] {
  return {
    file: new File(["x".repeat(2048)], "recording-1.webm", { type: "audio/webm" }),
    durationSeconds: 90,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  putWithProgress.mockResolvedValue(undefined);
});

describe("RecordingBar", () => {
  it("is not there when nothing is being recorded", () => {
    renderBar({ state: "idle" });

    // A strip across the bottom of every page in the app, always, would read as
    // a microphone that is always on.
    expect(screen.queryByRole("region", { name: "Recording controls" })).not.toBeInTheDocument();
  });

  it("shows the elapsed time, pause and stop while recording", () => {
    renderBar({ state: "recording", elapsed: 9 });

    expect(screen.getByRole("region", { name: "Recording controls" })).toBeInTheDocument();
    expect(screen.getByText("0:09")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  it("offers Resume instead of Pause once paused", () => {
    renderBar({ state: "paused" });

    expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
  });

  it("wires the transport buttons to the recorder", async () => {
    renderBar({ state: "recording" });

    await userEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(pause).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(stop).toHaveBeenCalled();
  });

  it("keeps the reminder next to the controls", () => {
    renderBar({ state: "recording" });

    // Recallix has no bot that announces itself in a participant list. The only
    // thing that tells the room is the person holding these controls.
    expect(screen.getByText("Always ask permission before recording")).toBeInTheDocument();
  });

  it("says the recording survives leaving the page, by being on every page", () => {
    // Not a copy assertion — the bar is rendered by the shell, so this test
    // renders it with no page around it at all and it still works.
    renderBar({ state: "recording" });

    expect(screen.getByRole("region", { name: "Recording controls" })).toBeInTheDocument();
  });
});

describe("RecordingBar microphone", () => {
  it("lists the microphones the browser reported", () => {
    renderBar({
      devices: [
        { deviceId: "a", label: "Headset (Jabra)", kind: "audioinput" },
        { deviceId: "b", label: "Built-in", kind: "audioinput" },
      ] as MediaDeviceInfo[],
    });

    expect(screen.getByRole("option", { name: "Headset (Jabra)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Built-in" })).toBeInTheDocument();
  });

  it("numbers a device the browser would not name", () => {
    // Before permission is granted every label comes back empty, and an option
    // with no text is one nobody can pick on purpose.
    renderBar({
      devices: [{ deviceId: "a", label: "", kind: "audioinput" }] as MediaDeviceInfo[],
    });

    expect(screen.getByRole("option", { name: "Microphone 1" })).toBeInTheDocument();
  });

  it("switches the microphone through the recorder", async () => {
    renderBar({
      devices: [
        { deviceId: "a", label: "Headset", kind: "audioinput" },
        { deviceId: "b", label: "Built-in", kind: "audioinput" },
      ] as MediaDeviceInfo[],
    });

    await userEvent.selectOptions(screen.getByLabelText("Microphone"), "b");

    expect(setDeviceId).toHaveBeenCalledWith("b");
  });

  it("treats the empty choice as the system default, not a device called nothing", async () => {
    renderBar({
      deviceId: "a",
      devices: [{ deviceId: "a", label: "Headset", kind: "audioinput" }] as MediaDeviceInfo[],
    });

    await userEvent.selectOptions(screen.getByLabelText("Microphone"), "");

    expect(setDeviceId).toHaveBeenCalledWith(null);
  });
});

describe("RecordingBar language", () => {
  it("saves the transcript language to the account", async () => {
    renderBar({ state: "recording" });

    await userEvent.selectOptions(screen.getByLabelText("Transcript language"), "es");

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ defaultLanguage: "es" }));
  });

  it("offers auto-detect", () => {
    renderBar({ state: "recording" });

    expect(screen.getByLabelText("Transcript language")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
  });
});

describe("RecordingBar silence warning", () => {
  it("says nothing while audio is arriving", () => {
    renderBar({ state: "recording", silentSeconds: 0 });

    expect(screen.queryByText("No audio is being captured")).not.toBeInTheDocument();
  });

  it("says nothing during an ordinary pause in the conversation", () => {
    renderBar({ state: "recording", silentSeconds: 3 });

    // Firing on every gap in the talking is how a warning becomes wallpaper.
    expect(screen.queryByText("No audio is being captured")).not.toBeInTheDocument();
  });

  it("warns once the silence has gone on too long to be a gap", () => {
    renderBar({ state: "recording", silentSeconds: 12 });

    expect(screen.getByText("No audio is being captured")).toBeInTheDocument();
    expect(screen.getByText(/microphone isn't muted/i)).toBeInTheDocument();
  });

  it("promises the recording is still running, so nobody stops a working one", () => {
    renderBar({ state: "recording", silentSeconds: 12 });

    expect(screen.getByText(/still running/i)).toBeInTheDocument();
  });

  it("does not warn about a paused recording being silent", () => {
    // It is silent because they paused it. Reporting that as a fault is
    // reporting the user's own action back to them as a problem.
    renderBar({ state: "paused", silentSeconds: 30 });

    expect(screen.queryByText("No audio is being captured")).not.toBeInTheDocument();
  });

  it("can be dismissed by somebody who really is recording a silent room", async () => {
    renderBar({ state: "recording", silentSeconds: 12 });

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("No audio is being captured")).not.toBeInTheDocument();
  });
});

describe("RecordingBar saving", () => {
  it("uploads, creates the meeting and opens it", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    expect(createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "audio/webm" }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/meetings/mtg_9"));
  });

  it("files the meeting as recorded", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    // What lets the recap email mean recordings without also meaning every
    // imported file.
    await waitFor(() =>
      expect(createMeeting).toHaveBeenCalledWith(expect.objectContaining({ recorded: true })),
    );
  });

  it("claims nothing about consent, now that nobody is asked", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    // This was `true` while the tick gated the start of a recording, which made
    // it a fact. Without the tick, sending it would stamp `consent_confirmed_at`
    // with a statement nobody made — and the privacy overview counts that
    // column and reports it back as one.
    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    expect(createMeeting).not.toHaveBeenCalledWith(
      expect.objectContaining({ consentConfirmed: true }),
    );
  });

  it("names it something, because the file is called recording-1755084000000.webm", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    await waitFor(() =>
      expect(createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/^Recording — /) }),
      ),
    );
  });

  it("uses the name that was typed at the top of the page", async () => {
    renderBar({ state: "stopped", result: aResult() }, { title: "Tuesday design review" });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    await waitFor(() =>
      expect(createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Tuesday design review" }),
      ),
    );
  });

  it("falls back to the date when the name is only whitespace", async () => {
    // Somebody who tabbed through the field and hit space should not end up
    // with a meeting called " " that is unfindable by name.
    renderBar({ state: "stopped", result: aResult() }, { title: "   " });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    await waitFor(() =>
      expect(createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/^Recording — /) }),
      ),
    );
  });

  it("clears the recorder once the audio is safely on the server", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    // Otherwise the bar follows you onto the meeting page still offering to
    // save audio that has already been saved.
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });

  it("keeps the audio when the upload fails", async () => {
    putWithProgress.mockRejectedValue(new Error("Upload failed (500)"));
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The recording only exists in this tab. Clearing it on a failed upload
    // destroys the meeting to tidy up after an error the user could retry.
    expect(reset).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("offers to throw it away, separately from saving it", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));

    expect(reset).toHaveBeenCalled();
  });

  it("shows how much there is to save", () => {
    renderBar({ state: "stopped", result: aResult() });

    expect(screen.getByText(/1:30/)).toBeInTheDocument();
  });
});

describe("RecordingBar live text", () => {
  it("has no switch to find", () => {
    renderBar({ state: "recording" });

    // It runs with the recording. A toggle meant the words only started once
    // somebody went looking for the control, by which point the sentence they
    // wanted to read had been and gone.
    expect(screen.queryByRole("button", { name: /Live text/ })).not.toBeInTheDocument();
  });
});

describe("RecordingBar clearance", () => {
  it("publishes its height for the page to leave room for", () => {
    renderBar({ state: "recording" });

    // The page cannot hard-code this: the bar grows a waveform, then a warning,
    // then a progress bar, and whatever is at the bottom of the page when it
    // does — always the newest line of the transcript — is what gets covered.
    expect(document.documentElement.style.getPropertyValue("--recording-bar")).not.toBe("");
  });

  it("takes the room back when there is no bar", () => {
    const { unmount } = renderBar({ state: "recording" });
    unmount();

    // Otherwise every page in the app keeps a hole at the bottom for a bar that
    // stopped existing.
    expect(document.documentElement.style.getPropertyValue("--recording-bar")).toBe("");
  });

  it("claims no room while idle", () => {
    renderBar({ state: "idle" });

    expect(document.documentElement.style.getPropertyValue("--recording-bar")).toBe("");
  });
});
