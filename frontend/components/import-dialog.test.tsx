import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The Import dialog.
 *
 * <p>Two things are being defended. The first is the absence of the upsell:
 * every product puts "3 of 3 imports left — upgrade for unlimited" under this
 * dropzone, Recallix has one free plan, and that line would advertise a product
 * that does not exist. It is the easiest thing in the world to add back by
 * copying a competitor's dialog.
 *
 * <p>The second is the language picker not lying. Recallix resolves the
 * transcription language when a meeting is enqueued, from the account — there
 * is no per-file language in the pipeline. A control here that read as "this
 * file's language" would silently do nothing to the file sitting above it, so
 * the copy has to say "future transcripts" and the test has to hold it there.
 */
const { createUploadUrl, createMeeting, update, push, toastError } = vi.hoisted(() => ({
  createUploadUrl: vi.fn(),
  createMeeting: vi.fn(),
  update: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
}));

let uploadFails: boolean;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/lib/uploads", async (orig) => ({
  ...(await orig<typeof import("@/lib/uploads")>()),
  probeDuration: () => Promise.resolve(61),
  putWithProgress: (_url: string, _f: File, onProgress: (n: number) => void) => {
    onProgress(100);
    return uploadFails ? Promise.reject(new Error("Upload failed (500)")) : Promise.resolve();
  },
}));

/**
 * The allowance, as the gate reads it. Generous by default so every test that
 * is not about the limit behaves as it did before there was one; the ones that
 * are about it narrow this in place.
 */
let usage = {
  plan: "FREE",
  minutesUsed: 0,
  minutesLimit: 100,
  importsUsed: 0,
  importsLimit: 3,
  meetingsUsed: 0,
};

vi.mock("@/lib/api", () => ({
  useGetUsageQuery: () => ({ data: usage, isLoading: false, isError: false }),
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
  useGetProjectQuery: (id: string) => ({
    data: id === "prj_1" ? { id, name: "Q4 planning" } : undefined,
  }),
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", endonym: "English" },
      { code: "es", name: "Spanish", endonym: "Español" },
      { code: "fr", name: "French", endonym: "Français" },
    ],
  }),
  useGetPreferencesQuery: () => ({ data: { defaultLanguage: null } }),
  useUpdatePreferencesMutation: () => [
    (arg: unknown) => {
      update(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
  ],
}));

import { ImportDialog } from "@/components/import-dialog";

function anAudioFile(name = "standup.m4a") {
  return new File(["x".repeat(2048)], name, { type: "audio/mp4" });
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadFails = false;
});

describe("ImportDialog", () => {
  it("is titled for what it does", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Transcribe audio and video" })).toBeInTheDocument();
  });

  it("offers both ways in", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("Drag & Drop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse files" })).toBeInTheDocument();
  });

  it("names the common formats without pretending they are the whole list", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    // The server takes any audio/* or video/*, so an eight-format allowlist in
    // the UI would turn a working file into a refusal.
    expect(screen.getByText(/MP3, M4A, WAV/)).toBeInTheDocument();
    expect(screen.getByText(/any other audio or video file/i)).toBeInTheDocument();
  });

  it("shows nothing at all about quotas or upgrading", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    for (const pattern of [/imports left/i, /upgrade/i, /unlimited/i, /business/i, /\bpro\b/i]) {
      expect(screen.queryByText(pattern)).not.toBeInTheDocument();
    }
  });

  it("takes a file and says what it is", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());

    expect(await screen.findByText("standup.m4a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload & process/ })).toBeEnabled();
  });

  it("keeps a long filename inside the dialog instead of pushing it wider", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    const long = "product-marketing-meeting-weekly-2021-06-28-320-kbps.mp3";
    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile(long));

    // jsdom does no layout, so this pins the three things that together make
    // the name shrink rather than the dialog grow. A grid item will not go
    // below its min-content width unless the column says it may, and one
    // unbreakable filename was enough to carry the file row, the language
    // select and the button out past the dialog's own border — which looked
    // like the dialog had been drawn twice, slightly offset.
    const name = await screen.findByText(long);
    expect(name).toHaveClass("truncate");
    expect(name.parentElement).toHaveClass("min-w-0");

    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("will not start without one", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Upload & process/ })).toBeDisabled();
  });

  it("uploads, creates the meeting, and lands on it", async () => {
    const onOpenChange = vi.fn();
    render(<ImportDialog open onOpenChange={onOpenChange} />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));

    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey: "k1", contentType: "audio/mp4" }),
    );
    // Not flagged as recorded: this file was captured somewhere Recallix was
    // not, which is what the imported-conversation email switch keys on.
    expect(createMeeting).not.toHaveBeenCalledWith(expect.objectContaining({ recorded: true }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/meetings/mtg_9"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open with the file still chosen when the server refuses", async () => {
    uploadFails = true;
    const onOpenChange = vi.fn();
    render(<ImportDialog open onOpenChange={onOpenChange} />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));

    // The commonest refusal here is the monthly limit. Closing the dialog would
    // take the message away along with the thing it was about.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("standup.m4a")).toBeInTheDocument();
  });

  it("refuses a PDF, which used to be accepted", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    // Dropped, not browsed: the input carries an `accept` filter, so the picker
    // never offers a PDF in the first place. Drag and drop ignores `accept`
    // entirely, which makes this guard the only thing standing between a file
    // the pipeline cannot use and a meeting that fails inside the worker.
    //
    // A PDF rather than some arbitrary junk, because it was accepted until
    // recently — it is the file somebody who used the old upload page will try.
    const pdf = new File(["x"], "notes.pdf", { type: "application/pdf" });
    fireEvent.drop(screen.getByRole("button", { name: /Drag and drop/i }), {
      dataTransfer: { files: [pdf] },
    });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/audio or video/i)),
    );
    expect(screen.queryByText("notes.pdf")).not.toBeInTheDocument();
  });

  it("takes a dropped file that the pipeline can read", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.drop(screen.getByRole("button", { name: /Drag and drop/i }), {
      dataTransfer: { files: [anAudioFile("interview.mp3")] },
    });

    expect(await screen.findByText("interview.mp3")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});

/**
 * The two controls this dialog used to carry, and no longer does.
 *
 * **A language picker**, which set the *account* default. The language is
 * resolved once, at enqueue, so it never applied to the file in the dropzone --
 * the copy had to spend two sentences saying so. A setting that cannot affect
 * what you are looking at belongs on the settings page, and Account Settings --
 * General still has it.
 *
 * **A speaker count**, offered as a hint and sent to AssemblyAI as a hard
 * constraint. Tell it two about a four-person call and two people are merged
 * into one; tell it four about a conversation and one person is split in half.
 * Its default was "work it out" and its own help text recommended leaving it
 * there, which is a control whose best answer is "do not touch me".
 *
 * Asserted rather than simply deleted, because both are the kind of thing that
 * comes back: the request must stay minimal, and the dialog must not start
 * writing to preferences again as a side effect of somebody importing a file.
 */
describe("what the dialog no longer asks", () => {
  it("offers no language picker", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByText(/languages supported/i)).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Select transcript language/ })).toBeNull();
    expect(screen.queryByText(/not to a file already dropped above/i)).toBeNull();
  });

  it("offers no speaker count", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByLabelText(/How many people are speaking/i)).toBeNull();
    expect(screen.queryByText(/a wrong answer/i)).toBeNull();
  });

  it("never writes to preferences, which importing a file has no business doing", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));

    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it("sends no speaker constraint, so the provider decides", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));
    await waitFor(() => expect(createMeeting).toHaveBeenCalled());

    // Absent, not zero. The API still accepts these fields; nothing sends them,
    // and an absent field is what the worker reads as automatic.
    const body = createMeeting.mock.calls[0][0];
    expect(body).not.toHaveProperty("expectedSpeakersMin");
    expect(body).not.toHaveProperty("expectedSpeakersMax");
  });
});

/**
 * Where an import lands.
 *
 * Import is in the shell's header, so the same button is pressed from Home and
 * from inside a folder — and until now it did the same thing both times, which
 * meant a file imported into a folder went to the top of the workspace and had
 * to be filed by hand afterwards, through a list of meetings already dealt
 * with. The destination is read from the page the dialog was opened over.
 */
describe("filing it as it arrives", () => {
  it("sends the folder it was opened in", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} projectId="prj_1" />);

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));

    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "prj_1" }),
    );
  });

  it("says where it is going before it goes", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} projectId="prj_1" />);

    // Filing silently is the same feature with none of the confidence. The
    // folder was chosen a click ago and the file will be gone from this dialog
    // in a moment; the difference is between "it went where I meant" and
    // "where has it gone".
    expect(screen.getByText("Q4 planning")).toBeInTheDocument();
  });

  it("sends nothing and says nothing when opened from anywhere else", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByText(/filing into/i)).not.toBeInTheDocument();

    await userEvent.upload(screen.getByTestId("import-file-input"), anAudioFile());
    await userEvent.click(screen.getByRole("button", { name: /Upload & process/ }));

    await waitFor(() => expect(createMeeting).toHaveBeenCalled());
    // Undefined, not null: the field is absent from the request, which is what
    // the server reads as unfiled.
    expect(createMeeting.mock.calls[0][0]).toMatchObject({ projectId: undefined });
  });
});
