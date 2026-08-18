import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The record page.
 *
 * <p>The page is in two halves and the seam is what these tests are mostly
 * about. Before a recording exists it asks the one thing that cannot be settled
 * afterwards — whether the room has been told — and after one exists it shows
 * the meeting instead. The setup does not linger in a disabled state, because a
 * form greyed out over a live meeting reads as something that failed rather
 * than something already decided.
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
  useUpdatePreferencesMutation: () => [vi.fn()],
}));

const recorder = vi.hoisted(() => ({ current: null as unknown }));
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/recording-context", () => ({
  useRecording: () => recorder.current,
  useRecordingSession: () => session.current,
}));

import RecordPage from "@/app/(app)/record/page";
import type { UseRecorder } from "@/lib/use-recorder";
import type { UseLiveTranscript } from "@/lib/use-live-transcript";
import type { RecordingSession } from "@/lib/recording-context";

const start = vi.fn().mockResolvedValue(undefined);
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

function renderPage(
  overrides: Partial<UseRecorder> = {},
  sessionOverrides: Partial<RecordingSession> = {},
) {
  session.current = {
    title: "",
    setTitle,
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
    start,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  } satisfies UseRecorder;
  return render(<RecordPage />);
}

beforeEach(() => vi.clearAllMocks());

describe("RecordPage before recording", () => {
  it("asks nothing that has only one answer", () => {
    renderPage();

    // There was a choice here between capturing another tab and capturing the
    // room. Only the room is left, and a picker with one option is a question
    // asked for the sake of asking.
    expect(screen.queryByRole("button", { name: /Online meeting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /In person/ })).not.toBeInTheDocument();
  });

  it("says what a microphone can and cannot hear", () => {
    renderPage();

    // The one thing somebody has to know before starting, and the one they
    // cannot fix afterwards: a voice arriving through an earpiece is not in the
    // room, so it is not in the recording.
    expect(screen.getByText(/headphones or an earpiece won't be on the recording/i))
      .toBeInTheDocument();
  });

  it("starts on one press, with nothing to agree to first", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Start recording/ }));

    await waitFor(() => expect(start).toHaveBeenCalledWith());
  });

  it("asks nothing before opening the microphone", () => {
    renderPage();

    // The capture-mode question had one answer left; the consent tick was
    // removed on request. What a Record button does now is record.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start recording/ })).toBeEnabled();
  });

  it("tells the server, so the account's other devices know", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Start recording/ }));

    // A laptop recording and a phone in a pocket are the same account, and the
    // microphone is the one thing the server cannot observe for itself.
    await waitFor(() => expect(announceRecording).toHaveBeenCalled());
  });

  it("still says who hears the meeting", () => {
    renderPage();

    // The disclosure was in the consent card and outlived it. Live text goes to
    // a third party Recallix would otherwise never have named.
    expect(screen.getByText(/audio goes to Google/i)).toBeInTheDocument();
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
  });

  it("has no date on a meeting that has not happened", () => {
    renderPage();

    expect(screen.getByText("Not started")).toBeInTheDocument();
  });

  it("lets the meeting be named before it starts", () => {
    renderPage();

    // The moment somebody knows what the meeting is, is before it happens.
    expect(screen.getByLabelText("Name this recording")).toBeInTheDocument();
  });
});

describe("RecordPage title", () => {
  it("takes a name without demanding one", async () => {
    renderPage({ state: "recording" });

    await userEvent.type(screen.getByLabelText("Name this recording"), "S");

    expect(setTitle).toHaveBeenCalled();
  });

  it("shows the fallback name as a placeholder, not as content", () => {
    const startedAt = new Date("2026-08-16T03:04:00");
    renderPage({ state: "recording", startedAt });

    // As a value it would have to be cleared before anything could be typed —
    // a name nobody chose, defended by the delete key.
    const field = screen.getByLabelText("Name this recording");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", expect.stringMatching(/^Recording — /));
  });

  it("keeps what was typed", () => {
    renderPage({ state: "recording" }, { title: "Tuesday design review" });

    expect(screen.getByLabelText("Name this recording")).toHaveValue("Tuesday design review");
  });
});

describe("RecordPage live text", () => {
  it("shows the words with the time they were said", () => {
    renderPage(
      { state: "recording" },
      {
        transcript: aTranscript({
          phrases: [
            { id: 1, at: 5, text: "Hello, hello, hello." },
            { id: 2, at: 20, text: "Shall we start?" },
          ],
        }),
      },
    );

    expect(screen.getByText("Hello, hello, hello.")).toBeInTheDocument();
    expect(screen.getByText("Shall we start?")).toBeInTheDocument();
    // The same timeline the finished transcript will use.
    expect(screen.getByText("0:05")).toBeInTheDocument();
    expect(screen.getByText("0:20")).toBeInTheDocument();
  });

  it("shows the phrase still being spoken", () => {
    renderPage(
      { state: "recording" },
      { transcript: aTranscript({ interim: "so the next thing" }) },
    );

    expect(screen.getByText("so the next thing")).toBeInTheDocument();
  });

  it("says plainly that this is not the transcript", () => {
    renderPage(
      { state: "recording" },
      {
        transcript: aTranscript({
          phrases: [{ id: 1, at: 5, text: "Hello." }],
        }),
      },
    );

    // It is unpunctuated, wrong about names, and thrown away. Presented as the
    // transcript it would be a product that transcribes badly.
    expect(screen.getByText(/rough preview from your browser's speech service/i))
      .toBeInTheDocument();
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
        transcript: aTranscript({
          phrases: [{ id: 1, at: 5, text: "Hello." }],
        }),
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
        transcript: aTranscript({
          phrases: [{ id: 1, at: 5, text: "Hello." }],
        }),
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

  it("dates the note from when recording began", () => {
    const startedAt = new Date("2026-08-16T03:04:00");
    renderPage({ state: "recording", startedAt, elapsed: 9 });

    expect(screen.getByText(startedAt.toLocaleString())).toBeInTheDocument();
  });

  it("names the owner when the account has said who that is", () => {
    renderPage({ state: "recording" });

    expect(screen.getByText(/Owner: Sam Okafor/)).toBeInTheDocument();
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
