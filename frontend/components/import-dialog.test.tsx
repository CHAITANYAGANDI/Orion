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

describe("ImportDialog transcript language", () => {
  it("counts the languages the server actually supports", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("3 languages supported")).toBeInTheDocument();
  });

  it("offers auto-detect first", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: /Select transcript language/ })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
  });

  it("saves it as the account default", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Select transcript language/ }),
      "es",
    );

    await waitFor(() => expect(update).toHaveBeenCalledWith({ defaultLanguage: "es" }));
  });

  it("says it does not apply to the file in the dropzone", () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    // The language is resolved at enqueue time from the account, so a picker
    // that read as per-file would do nothing to the file being dropped.
    expect(screen.getByText(/not to a file already dropped above/i)).toBeInTheDocument();
  });
});
