import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The record page.
 *
 * <p>There is no half before the recording any more, and most of this file is
 * about keeping it that way. Arriving opens the microphone: the route is only
 * ever reached by pressing Record, and a page answering that press with a
 * second button asking whether you meant it is a step that exists to be clicked
 * through. The two states left are the browser deciding, and the browser having
 * said no.
 *
 * <p>Several of these are negative, and deliberately so. There used to be a
 * second capture mode that recorded another browser tab, and most of what it
 * left behind was warnings: about Chrome, about sharing the wrong surface,
 * about having captured only one side of a conversation. With one source those
 * are not stale copy, they are copy that reports the product as broken.
 *
 * <p>The other thing held here is the sentence saying the transcript comes
 * after you stop. Recallix has no live transcription: the audio is captured in
 * the browser and only reaches the pipeline on Stop. A blank pane that looked
 * like it was waiting for words would promise captions the product does not
 * have, and the obvious conclusion to draw from it is that the microphone is
 * broken.
 */
const { announceRecording, push } = vi.hoisted(() => ({
  announceRecording: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/lib/api", () => ({
  useRecordingStartedMutation: () => [
    () => {
      announceRecording();
      return { unwrap: () => Promise.resolve({}) };
    },
  ],
  useGetPreferencesQuery: () => ({ data: { displayName: "Sam Okafor", defaultLanguage: null } }),
  useCreateUploadUrlMutation: () => [vi.fn()],
  useCreateMeetingMutation: () => [vi.fn()],
  useGetLanguagesQuery: () => ({ data: [] }),
  useGetProjectQuery: (id: string) => ({ data: { id, name: "Q4 planning" } }),
  useUpdatePreferencesMutation: () => [vi.fn()],
}));

const recorder = vi.hoisted(() => ({ current: null as unknown }));
const session = vi.hoisted(() => ({ current: null as unknown }));
const savejob = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/recording-context", () => ({
  useRecording: () => recorder.current,
  useRecordingSession: () => session.current,
  useRecordingJob: () => savejob.current,
}));

import RecordPage from "@/app/(app)/record/page";
import type { UseSaveJob } from "@/lib/use-save-job";
import type { UseRecorder } from "@/lib/use-recorder";
import type { LiveTurn, UseLiveTranscript } from "@/lib/use-live-transcript";
import type { RecordingSession } from "@/lib/recording-context";

const start = vi.fn().mockResolvedValue(undefined);
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

function aJob(overrides: Partial<UseSaveJob> = {}): UseSaveJob {
  return {
    phase: "idle",
    job: null,
    busy: false,
    stopping: false,
    save: vi.fn(),
    stop: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

function renderPage(
  overrides: Partial<UseRecorder> = {},
  sessionOverrides: Partial<RecordingSession> = {},
  jobOverrides: UseSaveJob = aJob(),
) {
  savejob.current = jobOverrides;
  session.current = {
    title: "",
    setTitle,
    returnTo: null,
    setReturnTo,
    transcript: aTranscript(),
    ...sessionOverrides,
  } satisfies RecordingSession;
  recorder.current = {
    state: "idle",
    elapsed: 0,
    startedAt: null,
    level: 0,
    silentSeconds: 0,
    error: null,
    result: null,
    supported: true,
    devices: [],
    deviceId: null,
    setDeviceId: vi.fn(),
    liveSource: null,
    start,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  } satisfies UseRecorder;
  return render(<RecordPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The address bar is shared state in jsdom, and half of these arrive at
  // /record with something on it.
  window.history.replaceState({}, "", "/record");
});

describe("RecordPage on arrival", () => {
  it("opens the microphone rather than offering to", async () => {
    renderPage();

    // The whole change: pressing Record starts a recording. A page in between
    // is a press to get past.
    await waitFor(() => expect(start).toHaveBeenCalledWith());
  });

  it("has nothing left to press", () => {
    renderPage();

    // "Ready to record", the paragraph under it, the Start button and the panel
    // listing the four stages afterwards: all gone. Each either restated the
    // button just pressed or described work that had not begun.
    expect(screen.queryByRole("button", { name: /Start recording/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Ready to record")).not.toBeInTheDocument();
    expect(screen.queryByText("What happens after you stop")).not.toBeInTheDocument();
  });

  it("says what the browser is being asked while it asks", () => {
    renderPage();

    // The permission prompt is modal and draws over the page. Nothing behind it
    // gives no clue what is being asked for or by whom.
    expect(screen.getByText(/Waiting for permission/i)).toBeInTheDocument();
  });

  it("asks nothing that has only one answer", () => {
    renderPage();

    // There was a choice here between capturing another tab and capturing the
    // room. Only the room is left, and a picker with one option is a question
    // asked for the sake of asking.
    expect(screen.queryByRole("button", { name: /Online meeting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /In person/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("tells the server, so the account's other devices know", async () => {
    renderPage();

    // A laptop recording and a phone in a pocket are the same account, and the
    // microphone is the one thing the server cannot observe for itself.
    await waitFor(() => expect(announceRecording).toHaveBeenCalled());
  });

  it("remembers where it was opened from", async () => {
    // /record?r=%2Ffolder%2Fprj_1 — the Otter shape, and the only thing a
    // reload of this page still has. The header's Record button says the same
    // in memory, but memory is what a reload just threw away.
    window.history.replaceState({}, "", "/record?r=%2Ffolder%2Fprj_1");

    renderPage();

    // Which is where the meeting files and where Discard goes back to. Held as
    // the path rather than the folder id: those are the same fact, and two
    // copies of one fact are two things that can disagree.
    await waitFor(() => expect(setReturnTo).toHaveBeenCalledWith("/folder/prj_1"));
  });

  it("takes Home when it was opened from nowhere in particular", async () => {
    renderPage();

    await waitFor(() => expect(setReturnTo).toHaveBeenCalledWith("/home"));
  });

  it("does not overwrite where a running recording came from", () => {
    // Reaching /record again while a recording started in a folder is under
    // way — the back button, a second press. The recording still belongs to
    // that folder, and the URL now says otherwise.
    window.history.replaceState({}, "", "/record");

    renderPage({ state: "recording" }, { returnTo: "/folder/prj_1" });

    expect(setReturnTo).not.toHaveBeenCalled();
  });

  it("says which folder the meeting will land in, and links to it", () => {
    renderPage({ state: "recording" }, { returnTo: "/folder/prj_1" });

    // Said now rather than discovered later: the folder was chosen a screen ago
    // and several minutes before the meeting will exist. A link, because it is
    // also the way back — leaving mid-recording is safe, the recorder lives in
    // the shell.
    const link = screen.getByRole("link", { name: "Q4 planning" });
    expect(link).toHaveAttribute("href", "/folder/prj_1");
  });

  it("says nothing about a folder when it was not started in one", () => {
    renderPage({ state: "recording" }, { returnTo: "/home" });

    // "Folder: —" reads as a missing value rather than as a meeting that
    // belongs nowhere in particular.
    expect(screen.queryByText(/Folder:/)).not.toBeInTheDocument();
  });

  it("does not reopen a microphone that is already open", () => {
    renderPage({ state: "recording" });

    // Coming back to the page mid-meeting, or pressing Record twice. A second
    // getUserMedia would restart the recorder and lose what was captured.
    expect(start).not.toHaveBeenCalled();
  });

  it("does not reopen it over audio that has not been saved", () => {
    renderPage({
      state: "stopped",
      result: { file: new File([""], "take.webm"), durationSeconds: 12 },
    });

    expect(start).not.toHaveBeenCalled();
  });

  it("draws nothing at all while the save hands over to the meeting", () => {
    // The real sequence: a finished recording, then `save()` releasing the
    // audio a tick before the route changes. Drawing the idle state in that gap
    // puts "Waiting for permission…" on screen as though a recording were about
    // to start — the last thing somebody sees of a meeting they just saved.
    const view = renderPage({
      state: "stopped",
      result: { file: new File([""], "take.webm"), durationSeconds: 12 },
    });

    recorder.current = { ...(recorder.current as UseRecorder), state: "idle", result: null };
    savejob.current = aJob({ phase: "processing" });
    view.rerender(<RecordPage />);

    expect(screen.queryByText(/Waiting for permission/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
  });

  it("still asks for the microphone when nothing is being saved", () => {
    // The guard above must not swallow the ordinary arrival.
    renderPage();

    expect(screen.getByText(/Waiting for permission/i)).toBeInTheDocument();
  });

  it("asks for the microphone even while an earlier meeting is still processing", () => {
    // Nothing stops you recording the next one. Sitting blank behind somebody
    // else's progress bar would be the guard above overreaching.
    renderPage({ state: "idle" }, {}, aJob({ phase: "processing" }));

    expect(screen.getByText(/Waiting for permission/i)).toBeInTheDocument();
  });

  it("carries no standing explanation before a recording", () => {
    renderPage();

    // Both paragraphs were removed on request: what the microphone can hear,
    // and where the live preview goes. Asserted rather than merely deleted,
    // because the second was a disclosure — Chrome sends that preview audio to
    // Google — and putting it back is the sort of change that should be a
    // decision rather than a reflex.
    expect(screen.queryByText(/audio goes to Google/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pick up in the room/i)).not.toBeInTheDocument();
  });

  it("no longer warns about a browser requirement it does not have", () => {
    renderPage();

    // Tab capture was the only part that needed Chrome or Edge. Plain
    // getUserMedia works everywhere, so this warning would now be telling
    // somebody their working setup is broken.
    expect(screen.queryByText(/needs Chrome or Edge/i)).not.toBeInTheDocument();
  });

  it("sends a browser that cannot record somewhere it can", () => {
    renderPage({ supported: false });

    expect(screen.getByText(/can't record audio/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Upload a file instead/ })).toBeInTheDocument();
    // And does not ask it for a microphone it has already said it has not got.
    expect(start).not.toHaveBeenCalled();
  });

  it("offers a way back when the microphone is refused", async () => {
    renderPage({ error: "Microphone access was denied. Recallix needs it to record you." });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The recording never began, so without this the route is a dead end with a
    // red banner on it — and the browser will not prompt again unasked.
    expect(screen.getByText(/denied/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("does not ask again by itself once it has been refused", async () => {
    // A denial puts the recorder back to idle with an error. Keyed on idle
    // rather than on mount, this would re-prompt the instant it was denied and
    // keep re-prompting for as long as the page stayed open.
    const view = renderPage();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    recorder.current = {
      ...(recorder.current as UseRecorder),
      error: "Microphone access was denied.",
    };
    view.rerender(<RecordPage />);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("carries no heading, name field or date before a recording", () => {
    renderPage();

    // All removed on request. Recordings are saved under the date now and
    // renamed on the meeting page, where the meeting has actually happened and
    // somebody knows what to call it.
    expect(screen.queryByLabelText("Name this recording")).not.toBeInTheDocument();
    expect(screen.queryByText("Not started")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Upload a recording instead/ }),
    ).not.toBeInTheDocument();
  });

});

describe("RecordPage note heading", () => {
  const startedAt = new Date("2026-08-19T06:05:00");

  it("names the note, dates it and says whose it is", () => {
    renderPage({ state: "recording", startedAt });

    expect(screen.getByLabelText("Name this note")).toBeInTheDocument();
    expect(screen.getByText(/Aug 19, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Owner: Sam Okafor/)).toBeInTheDocument();
  });

  it("offers the name as a placeholder, not as content", () => {
    renderPage({ state: "recording", startedAt });

    // A value would have to be cleared before anything could be typed — a name
    // nobody chose, defended by the delete key.
    const field = screen.getByLabelText("Name this note");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "Note");
  });

  it("keeps what was typed, since the session outlives this page", () => {
    renderPage({ state: "recording", startedAt }, { title: "Tuesday design review" });

    expect(screen.getByLabelText("Name this note")).toHaveValue("Tuesday design review");
  });

  it("takes a name without demanding one", async () => {
    renderPage({ state: "recording", startedAt });

    await userEvent.type(screen.getByLabelText("Name this note"), "S");

    expect(setTitle).toHaveBeenCalled();
  });

  it("dates the note from when recording began, not from the clock", () => {
    renderPage({ state: "recording", startedAt, elapsed: 90 });

    // Read from the clock it would tick over while the meeting ran, and the
    // heading would disagree with the recording underneath it.
    expect(screen.getByText(/6:05/)).toBeInTheDocument();
  });

  it("says nothing about a note that does not exist yet", () => {
    renderPage({ state: "idle" });

    // Before Start there is no note. A name field over an empty page asks
    // somebody to title a meeting that has not happened.
    expect(screen.queryByLabelText("Name this note")).not.toBeInTheDocument();
    expect(screen.queryByText(/Owner:/)).not.toBeInTheDocument();
  });
});

describe("RecordPage processing", () => {
  it("does not draw the pipeline, which happens after this page is left", () => {
    // Saving navigates to the meeting and the wait is drawn there, so by the
    // time there is anything to watch this page is behind you.
    renderPage(
      { state: "idle" },
      {},
      aJob({
        phase: "processing",
        job: { id: "mtg_9", status: "TRANSCRIBING", progress: 40, message: "Transcribing…" },
      }),
    );

    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop processing/ })).not.toBeInTheDocument();
  });
});

describe("RecordPage live text", () => {
  it("shows the words with the speaker and the time they were said", () => {
    renderPage(
      { state: "recording" },
      {
        transcript: aTranscript({
          turns: [
            aTurn({ id: "1:1", at: 4, speaker: "Speaker 1", text: "Hello, hello, hello." }),
            aTurn({ id: "1:2", at: 20, speaker: "Speaker 2", text: "Shall we start?" }),
          ],
        }),
      },
    );

    expect(screen.getByText("Hello, hello, hello.")).toBeInTheDocument();
    expect(screen.getByText("Shall we start?")).toBeInTheDocument();
    // Who said it, which the browser-speech preview could not answer at all.
    expect(screen.getByText(/Speaker 1 \u00b7/)).toBeInTheDocument();
    expect(screen.getByText(/Speaker 2 \u00b7/)).toBeInTheDocument();
    // The provider's own timeline, and the one the finished transcript uses.
    expect(screen.getByText(/0:04/)).toBeInTheDocument();
    expect(screen.getByText(/0:20/)).toBeInTheDocument();
  });

  it("says it is working out who is speaking rather than guessing", () => {
    // Filing an unattributed turn under Speaker 1 puts a quotation beside
    // somebody who may never have said it, and during a live meeting that name
    // is read and acted on.
    renderPage(
      { state: "recording" },
      {
        transcript: aTranscript({
          turns: [aTurn({ speaker: "Unknown speaker", speakerStatus: "unknown", text: "mm hm" })],
        }),
      },
    );

    expect(screen.getByText(/Identifying speaker/)).toBeInTheDocument();
    expect(screen.queryByText(/Speaker 1/)).not.toBeInTheDocument();
  });

  it("shows the turn still being spoken", () => {
    renderPage(
      { state: "recording" },
      {
        transcript: aTranscript({
          pending: aTurn({ id: "1:9", text: "so the next thing", final: false }),
        }),
      },
    );

    expect(screen.getByText("so the next thing")).toBeInTheDocument();
  });

  it("no longer calls the live text the browser's own speech service", () => {
    renderPage(
      { state: "recording" },
      { transcript: aTranscript({ turns: [aTurn()] }) },
    );

    // It was true and is not any more. The words come from the same provider
    // that writes the final transcript, over a websocket, with diarization --
    // calling them the browser's would now be the misleading claim.
    expect(screen.queryByText(/rough preview from your browser/i)).not.toBeInTheDocument();
  });

  it("shows nothing until somebody says something", () => {
    renderPage({ state: "recording" });

    // Not an empty state, an empty page. The timer, the waveform and the red
    // Stop button in the bar are already saying that this is recording.
    expect(screen.queryByText(/live text/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
  });

  it("shows nothing extra in a browser that cannot do it either", () => {
    renderPage({ state: "recording" }, { transcript: aTranscript({ supported: false }) });

    expect(screen.queryByText(/speech recognition/i)).not.toBeInTheDocument();
  });

  it("still reports a live-text failure, without dressing it as a status", () => {
    renderPage(
      { state: "recording" },
      { transcript: aTranscript({ error: "Live text stopped." }) },
    );

    // Worth saying, because the words stop arriving and the reason is not
    // otherwise visible. Not worth a panel: the recording is unaffected.
    expect(screen.getByText("Live text stopped.")).toBeInTheDocument();
  });

  it("keeps the words up after Stop, while there is a decision to make", () => {
    renderPage(
      {
        state: "stopped",
        result: { file: new File(["x"], "r.webm", { type: "audio/webm" }), durationSeconds: 90 },
      },
      {
        transcript: aTranscript({ turns: [aTurn({ at: 5, text: "Hello." })] }),
      },
    );

    // Clearing the pane at the moment somebody chooses between Save and Discard
    // takes away the thing that choice is about.
    expect(screen.getByText("Hello.")).toBeInTheDocument();
  });

  it("does not claim to be transcribing a paused meeting", () => {
    renderPage(
      { state: "paused" },
      {
        transcript: aTranscript({ turns: [aTurn({ at: 5, text: "Hello." })] }),
      },
    );

    expect(screen.getByText(/nothing is being recorded or transcribed/i)).toBeInTheDocument();
  });
});

describe("RecordPage while recording", () => {
  it("puts the setup away once the decisions are made", () => {
    renderPage({ state: "recording", elapsed: 9 });

    // Left on screen and disabled, these read as a form that failed rather than
    // one already filled in.
    expect(screen.queryByRole("button", { name: /Online meeting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start recording/ })).not.toBeInTheDocument();
  });

  it("says nothing at all until the meeting does", () => {
    renderPage({ state: "recording" });

    // There was a panel here restating what the control bar already shows — a
    // running timer, a moving waveform, a red Stop. It occupied the space the
    // words are about to appear in, to say that words were not appearing.
    expect(screen.queryByText(/^Recording$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Listening/i)).not.toBeInTheDocument();
  });

  it("does not call microphone-only a problem, now that it is the design", () => {
    renderPage({ state: "recording" });

    // This warning existed because a mode that was supposed to capture other
    // participants sometimes did not. With nothing else to capture it would be
    // reporting the product as a fault.
    expect(screen.queryByText(/Microphone only/)).not.toBeInTheDocument();
  });

  it("explains what the browser is waiting for", () => {
    renderPage({ state: "requesting" });

    expect(screen.getByText(/Waiting for permission/i)).toBeInTheDocument();
    expect(screen.getByText(/Allow the microphone/i)).toBeInTheDocument();
  });

  it("surfaces a recorder failure rather than sitting there", () => {
    renderPage({ state: "recording", error: "Couldn't switch microphone." });

    expect(screen.getByText("Couldn't switch microphone.")).toBeInTheDocument();
  });
});

describe("RecordPage after stopping", () => {
  it("says the audio is still only in this tab", () => {
    renderPage({
      state: "stopped",
      result: {
        file: new File(["x"], "recording-1.webm", { type: "audio/webm" }),
        durationSeconds: 90,
      },
    });

    // The single easiest thing in the app to lose: captured, not yet uploaded,
    // and gone if the tab closes.
    expect(screen.getByText(/closing the tab now would lose the audio/i)).toBeInTheDocument();
  });

  it("does not offer to start another one over the top", () => {
    renderPage({
      state: "stopped",
      result: {
        file: new File(["x"], "recording-1.webm", { type: "audio/webm" }),
        durationSeconds: 90,
      },
    });

    expect(screen.queryByRole("button", { name: /^Start recording/ })).not.toBeInTheDocument();
  });
});
