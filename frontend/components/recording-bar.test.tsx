import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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
  deleteMeeting,
  subscribeMeetingStatus,
  deactivate,
  polled,
} = vi.hoisted(() => ({
  createUploadUrl: vi.fn(),
  createMeeting: vi.fn(),
  updatePreferences: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  putWithProgress: vi.fn(),
  deleteMeeting: vi.fn(),
  subscribeMeetingStatus: vi.fn(),
  deactivate: vi.fn(),
  // What GET /meetings/{id} would say, for the poll that backs up the socket.
  polled: { current: undefined as unknown },
}));

/**
 * The socket, held open so a test can push a stage through it.
 *
 * <p>`emit` is whatever handler the bar last registered. Calling it is the only
 * way to move the pipeline on in a test, because nothing else here is real.
 */
let emit: ((e: unknown) => void) | null = null;

vi.mock("@/lib/ws", () => ({
  subscribeMeetingStatus: (id: string, handlers: { onEvent: (e: unknown) => void }) => {
    subscribeMeetingStatus(id);
    emit = handlers.onEvent;
    return { deactivate };
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname.current }));

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
const savejob = vi.hoisted(() => ({ current: null as unknown }));
const pathname = vi.hoisted(() => ({ current: "/home" }));

vi.mock("@/lib/recording-context", () => ({
  useRecording: () => recorder.current,
  useRecordingSession: () => session.current,
  useRecordingJob: () => savejob.current,
}));

import { RecordingBar } from "@/components/recording-bar";
import type { UseRecorder } from "@/lib/use-recorder";
import type { LiveTurn, UseLiveTranscript } from "@/lib/use-live-transcript";
import type { RecordingSession } from "@/lib/recording-context";
import type { UseSaveJob } from "@/lib/use-save-job";

const pause = vi.fn();
const saveJob = vi.fn();
const stopJob = vi.fn();
const dismissJob = vi.fn();
const resume = vi.fn();
const stop = vi.fn();
const reset = vi.fn();
const setDeviceId = vi.fn();
const setTitle = vi.fn();
const setReturnTo = vi.fn();

function aTranscript(overrides: Partial<UseLiveTranscript> = {}): UseLiveTranscript {
  return {
    supported: true,
    status: "listening",
    turns: [],
    pending: null,
    error: null,
    reconnects: 0,
    clear: vi.fn(),
    ...overrides,
  };
}

/** One settled turn, as the streaming provider hands it over. */
function aTurn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id: "1:1:0",
    turnKey: "1:1",
    at: 0,
    speaker: "Speaker 1",
    speakerKey: "spk_1",
    speakerRaw: "A",
    speakerStatus: "attributed",
    text: "Hello.",
    final: true,
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
    liveSource: null,
    start: vi.fn(),
    pause,
    resume,
    stop,
    reset,
    ...overrides,
  };
}

function aJob(overrides: Partial<UseSaveJob> = {}): UseSaveJob {
  return {
    phase: "idle",
    job: null,
    busy: false,
    stopping: false,
    save: saveJob,
    stop: stopJob,
    dismiss: dismissJob,
    ...overrides,
  };
}

/** A save that has reached the pipeline, on meeting mtg_9. */
function processing(): UseSaveJob {
  return aJob({
    phase: "processing",
    job: { id: "mtg_9", status: "TRANSCRIBING", progress: 40, message: "Generating transcript from audio…" },
  });
}

/** A save still sending the bytes. */
function uploading(): UseSaveJob {
  return aJob({ phase: "uploading", busy: true });
}

function renderBar(
  overrides: Partial<UseRecorder> = {},
  sessionOverrides: Partial<RecordingSession> = {},
  jobOverrides: UseSaveJob = aJob(),
) {
  savejob.current = jobOverrides;
  recorder.current = aRecorder(overrides);
  session.current = {
    title: "",
    setTitle,
    returnTo: null,
    setReturnTo,
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
  emit = null;
  polled.current = undefined;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  pathname.current = "/home";
});

/** Save the recording on screen and wait for the pipeline to be watched. */
async function save() {
  await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));
  await waitFor(() => expect(createMeeting).toHaveBeenCalled());
}

/** Push a pipeline stage down the socket the bar subscribed to. */
async function stage(status: string, progress: number, message: string) {
  await waitFor(() => expect(emit).not.toBeNull());
  await act(async () => {
    emit!({ meetingId: "mtg_9", status, progress, message });
  });
}

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

  it("stands down for the upload, and puts nothing in its place", () => {
    // Removed on request, twice over: first the percentage docked here, then
    // the modal that replaced it. Against local storage the upload is over in
    // milliseconds, so either one was a flash between pressing Save and
    // arriving at the meeting, which reads as a fault rather than as progress.
    const { container } = renderBar(
      { state: "stopped", result: aResult() },
      {},
      uploading(),
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("has no in-flight state left to draw", () => {
    // The audio in hand, and no save running. Save and Discard are plain: an
    // upload can never be reached from here, because the bar is gone before
    // one is under way.
    renderBar({ state: "stopped", result: aResult() });

    expect(screen.getByRole("button", { name: /Save & process/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Discard/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Working/ })).not.toBeInTheDocument();
  });

  it("says the recording survives leaving the page, by being on every page", () => {
    // Not a copy assertion — the bar is rendered by the shell, so this test
    // renders it with no page around it at all and it still works.
    renderBar({ state: "recording" });

    expect(screen.getByRole("region", { name: "Recording controls" })).toBeInTheDocument();
  });
});

describe("RecordingBar microphone", () => {
  const two = [
    { deviceId: "a", label: "Headset (Jabra)", kind: "audioinput" },
    { deviceId: "b", label: "Built-in", kind: "audioinput" },
  ] as MediaDeviceInfo[];

  async function openMics(overrides: Partial<UseRecorder> = {}) {
    renderBar({ devices: two, ...overrides });
    await userEvent.click(screen.getByRole("button", { name: "Microphone" }));
  }

  it("hangs off the microphone glyph rather than beside it", async () => {
    renderBar({ devices: two });

    // Two objects saying "microphone" where one will do, and the wider of them
    // read "System default" for nearly everybody — a device name's worth of bar
    // spent on no information.
    const trigger = screen.getByRole("button", { name: "Microphone" });
    expect(trigger).toHaveAttribute("title", "Microphone: System default");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("names the chosen device where the list is not open", () => {
    renderBar({ devices: two, deviceId: "a" });

    // The name is worth having and not worth the width. On the trigger it costs
    // nothing and is one hover away.
    expect(screen.getByRole("button", { name: "Microphone" })).toHaveAttribute(
      "title",
      "Microphone: Headset (Jabra)",
    );
  });

  it("lists the microphones the browser reported", async () => {
    await openMics();

    expect(screen.getByRole("menuitem", { name: /Headset \(Jabra\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Built-in/ })).toBeInTheDocument();
  });

  it("numbers a device the browser would not name", async () => {
    // Before permission is granted every label comes back empty, and an item
    // with no text is one nobody can pick on purpose.
    await openMics({
      devices: [{ deviceId: "a", label: "", kind: "audioinput" }] as MediaDeviceInfo[],
    });

    expect(screen.getByRole("menuitem", { name: /Microphone 1/ })).toBeInTheDocument();
  });

  it("switches the microphone through the recorder", async () => {
    await openMics();

    await userEvent.click(screen.getByRole("menuitem", { name: /Built-in/ }));

    expect(setDeviceId).toHaveBeenCalledWith("b");
  });

  it("treats the system default as a choice, not as a device called nothing", async () => {
    await openMics({ deviceId: "a" });

    await userEvent.click(screen.getByRole("menuitem", { name: /System default/ }));

    expect(setDeviceId).toHaveBeenCalledWith(null);
  });
});

describe("RecordingBar language", () => {
  it("carries no transcript language, in either state", () => {
    // It never configured the recording in front of you: it wrote the account
    // default, resolved when the meeting is enqueued. An account setting in the
    // clothes of a live control, still on screen after Stop where there was
    // nothing left for it to affect. It lives in Settings and the import dialog.
    renderBar({ state: "recording" });
    expect(screen.queryByLabelText("Transcript language")).not.toBeInTheDocument();

    renderBar({ state: "stopped", result: aResult() });
    expect(screen.queryByLabelText("Transcript language")).not.toBeInTheDocument();
  });

  it("keeps the microphone picker, which does act on this recording", () => {
    // Switching microphone mid-meeting is something the recorder handles
    // without splitting the file, so this one belongs beside the waveform.
    renderBar({ state: "recording" });

    expect(screen.getByLabelText("Microphone")).toBeInTheDocument();
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
  it("hands the recording and the typed name to the save", async () => {
    renderBar({ state: "stopped", result: aResult() }, { title: "  Tuesday design review  " });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    expect(saveJob).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 90 }),
      "Tuesday design review",
      null,
    );
  });

  it("files it into the folder Record was pressed in", async () => {
    renderBar({ state: "stopped", result: aResult() }, { returnTo: "/folder/prj_1" });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    // Captured when Record was pressed, minutes ago and a screen away. By the
    // time Save is pressed the pathname is /record or wherever the user
    // wandered, so there is no folder left to read — which is how a recording
    // started inside a folder used to end up at the top of the workspace.
    expect(saveJob.mock.calls[0][2]).toBe("prj_1");
  });

  it("files it nowhere when Record was pressed somewhere that is not a folder", async () => {
    renderBar({ state: "stopped", result: aResult() }, { returnTo: "/folders" });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    expect(saveJob.mock.calls[0][2]).toBeNull();
  });

  it("files it nowhere when it was not started in one", async () => {
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    expect(saveJob.mock.calls[0][2]).toBeNull();
  });

  it("names it something, because the file is called recording-1755084000000.webm", async () => {
    renderBar({ state: "stopped", result: aResult() }, { title: "   " });

    await userEvent.click(screen.getByRole("button", { name: /Save & process/ }));

    expect(saveJob.mock.calls[0][1]).toMatch(/^Recording — /);
  });

  it("does not offer to save a recording that captured nothing", () => {
    renderBar({
      state: "stopped",
      result: {
        file: new File([], "recording-2.webm", { type: "audio/webm" }),
        durationSeconds: 0,
      },
    });

    // Stopping in the first moment can leave every chunk empty. Uploading that
    // spends a presign and a PUT to be refused, and the refusal talks about
    // object sizes rather than about what happened.
    expect(screen.queryByRole("button", { name: /Save & process/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No audio was captured/)).toBeInTheDocument();
    // The way out is still there, which is the whole point.
    expect(screen.getByRole("button", { name: /Discard/ })).toBeEnabled();
  });

  it("takes Discard away with the rest of it once a save starts", () => {
    // Discard used to be left disabled rather than removed, so that a stuck
    // phase could not strand somebody in a bar with no way out. There is no
    // bar to be stranded in now: the dialog is the whole of that stretch.
    const { container } = renderBar(
      { state: "stopped", result: aResult() },
      {},
      aJob({ phase: "uploading", busy: true }),
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("leaves the record page when the recording is discarded", async () => {
    pathname.current = "/record";
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));

    // That page has nothing left to show once the audio is gone — worse, it
    // opens the microphone on arrival, so staying would start another
    // recording. Home, because there is nowhere else to have come from.
    expect(reset).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/home");
  });

  it("goes back to the folder it was started in, not to Home", async () => {
    pathname.current = "/record";
    renderBar({ state: "stopped", result: aResult() }, { returnTo: "/folder/prj_1" });

    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));

    // Somebody who opened a folder, pressed Record and thought better of it was
    // in that folder a minute ago and has not asked to leave it.
    expect(push).toHaveBeenCalledWith("/folder/prj_1");
  });

  it("will not be sent back to the recorder by a doctored return path", async () => {
    pathname.current = "/record";
    renderBar({ state: "stopped", result: aResult() }, { returnTo: "//evil.example" });

    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));

    // `returnTo` starts life as ?r= on the address bar. Everything unrecognised
    // is Home rather than an error: the recording is what matters here.
    expect(push).toHaveBeenCalledWith("/home");
  });

  it("is gone the moment the audio is on the server, on every page", () => {
    // Removed on request. It used to follow the reader from page to page for
    // the length of a pipeline run, with a percentage for work nobody was
    // watching. The meeting's own page draws that wait now — see
    // components/processing-card.tsx — and this stops at the upload.
    for (const path of ["/home", "/ask", "/record", "/meetings/mtg_9", "/meetings/mtg_other"]) {
      pathname.current = path;
      const { container, unmount } = renderBar({ state: "idle" }, {}, processing());
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("is gone while the bytes are going too, on every page", () => {
    for (const path of ["/home", "/ask", "/record", "/meetings/mtg_9"]) {
      pathname.current = path;
      const { container, unmount } = renderBar({ state: "idle" }, {}, uploading());
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("stays put when the recording is discarded from anywhere else", async () => {
    pathname.current = "/meetings/mtg_1";
    renderBar({ state: "stopped", result: aResult() });

    await userEvent.click(screen.getByRole("button", { name: /Discard/ }));

    // The bar is incidental to whatever is being read here. Navigating away
    // because somebody tidied up a recording is the one nobody asked for.
    expect(reset).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("goes as soon as the recorder has been let go and the bytes have landed", () => {
    // The audio is on the server. Everything after this belongs to the meeting
    // it became, on that meeting's page.
    renderBar({ state: "idle", result: null }, {}, processing());

    expect(
      screen.queryByRole("region", { name: "Recording controls" }),
    ).not.toBeInTheDocument();
  });

  it("offers no way to stop a pipeline, because it no longer shows one", () => {
    // Stop moved onto the meeting page with the progress it belongs to. Left
    // here it would be a control for something invisible.
    renderBar({ state: "idle", result: null }, {}, processing());

    expect(screen.queryByRole("button", { name: /Stop processing/ })).not.toBeInTheDocument();
    expect(stopJob).not.toHaveBeenCalled();
  });

  it("still carries a live recording on the record page", () => {
    // Pause, the timer and the waveform exist nowhere else.
    pathname.current = "/record";
    renderBar({ state: "recording" });

    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
  });

  it("says nothing about a finished job, because the meeting is already opening", () => {
    // The result panel that used to sit here — "Ready to read", Open meeting,
    // Dismiss — was a second copy of what the record page draws, ending in a
    // button for something that now happens on its own.
    renderBar(
      { state: "idle", result: null },
      {},
      aJob({ phase: "done", job: { id: "mtg_9", status: "READY", progress: 100, message: "" } }),
    );

    expect(screen.queryByRole("button", { name: /Open meeting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Ready to read/)).not.toBeInTheDocument();
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
