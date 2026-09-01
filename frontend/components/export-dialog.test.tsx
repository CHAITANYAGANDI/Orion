import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The export dialog.
 *
 * <p>These guard the things a download can get wrong without saying so. It can
 * be the wrong size — a forty-page transcript when somebody wanted a two-page
 * brief to attach to an email — and it can be in the wrong language, which is
 * worse: a Spanish summary exported as English looks like a working file until
 * somebody who reads only Spanish opens it.
 *
 * <p>Since it grew a second pane there is a third thing to hold down: the
 * options on the left and the preview on the right have to be describing the
 * same document. A preview that ignores a tickbox is worse than no preview,
 * because it is evidence for the wrong answer.
 *
 * <p>And a fourth: <b>a part that did not download must never look like one
 * that did</b>. Delivery is all-or-nothing — one file when one thing was
 * chosen, one archive when more were, and nothing at all if any part failed.
 * The message must say which part, and the choices must survive so the retry is
 * a click rather than a reconstruction.
 *
 * <p>Audio has no format choice: it is always MP3. The Original option is gone,
 * and one test below exists purely to make sure it stays gone.
 */
const { fetchExportFile, fetchSignedFile, save, fetchMp3, toastError, toastSuccess } =
  vi.hoisted(() => ({
    fetchExportFile: vi.fn(),
    fetchSignedFile: vi.fn(),
    save: vi.fn(),
    fetchMp3: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  }));

/*
 * The archive builder, the failure wording and the error types are left real:
 * they are the fix, and a mock of them would be a test of the mock. Only the
 * three functions that need a network or a browser are stood in for.
 */
vi.mock("@/lib/exports", async (orig) => ({
  ...(await orig<typeof import("@/lib/exports")>()),
  fetchExportFile: (...args: unknown[]) => fetchExportFile(...args),
  fetchSignedFile: (...args: unknown[]) => fetchSignedFile(...args),
  save: (...args: unknown[]) => save(...args),
}));

vi.mock("@/lib/api", () => ({
  API_BASE: "http://api.test",
  useLazyGetMp3ExportQuery: () => [
    (id: string) => ({ unwrap: () => fetchMp3(id) }),
    { isFetching: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { ExportDialog } from "@/components/export-dialog";
import { DownloadFailure, ExportError } from "@/lib/exports";
import type { SummaryResponse, TranscriptSegment } from "@/lib/types";

const SUMMARY = {
  meetingId: "mtg_1",
  shortSummary: "We agreed to move billing to Stripe.",
  detailedSummary: "We agreed to move billing to Stripe.",
  keyPoints: ["Stripe by Q4"],
  sections: [
    {
      key: "overview",
      title: "Overview",
      kind: "prose",
      text: "We agreed to move billing to Stripe.",
      bullets: [],
      groups: [],
    },
    {
      key: "outline",
      title: "Outline",
      kind: "outline",
      text: "",
      bullets: [],
      groups: [{ heading: "Billing", bullets: ["Stripe won on fees"], startSeconds: 12 }],
    },
  ],
} as unknown as SummaryResponse;

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 4, speaker: "Priya", text: "Right, shall we start?" },
  { start: 4, end: 9, speaker: "Priya", text: "I had one more thing." },
  { start: 9, end: 14, speaker: "Marcus", text: "Go ahead." },
];

function open(props: Partial<React.ComponentProps<typeof ExportDialog>> = {}) {
  return render(
    <ExportDialog
      open
      onOpenChange={vi.fn()}
      meetingId="mtg_1"
      summary={SUMMARY}
      actionItems={[{ id: "ai_1", title: "Draft the rollout plan" }] as never}
      segments={SEGMENTS}
      transcriptLines={412}
      {...props}
    />,
  );
}

/** A rendered document coming back from the export endpoint. */
function document_(name: string, body = "content") {
  return { blob: new Blob([body]), filename: name };
}

/** The options the last document request was made with. */
function lastOptions() {
  return fetchExportFile.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

/** The options of the call that asked for the transcript. */
function transcriptCall() {
  return fetchExportFile.mock.calls.find(
    (c) => (c[2] as Record<string, unknown>)?.transcript === true,
  )?.[2] as Record<string, unknown>;
}

const READY_MP3 = {
  status: "ready",
  url: "https://r2/signed.mp3",
  filename: "sprint-planning.mp3",
  contentType: "audio/mpeg",
  expiresInSeconds: 900,
};

/** Real MPEG framing, so an assertion about "contains audio" means something. */
const MPEG = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22]);

beforeEach(() => {
  /*
   * `resetAllMocks`, not `clearAllMocks`. The latter clears recorded calls and
   * leaves queued `...Once` implementations in place, so a test that queues two
   * and consumes one leaks the other into whatever runs next -- which happens
   * routinely now that a failed part stops the ones after it from being
   * fetched at all. It cost an afternoon once; every implementation this file
   * relies on is re-established immediately below.
   */
  vi.resetAllMocks();
  fetchExportFile.mockResolvedValue(document_("sprint-planning.txt"));
  fetchMp3.mockResolvedValue(READY_MP3);
  fetchSignedFile.mockImplementation(async (_url: string, filename: string) => ({
    blob: new Blob([MPEG], { type: "audio/mpeg" }),
    filename,
  }));
});

describe("ExportDialog choosing", () => {
  it("starts with the summary and without the transcript", async () => {
    open();

    expect(screen.getByText("1 file to export")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // The commonest export by a distance, and the one that fits in an email.
    await waitFor(() => expect(fetchExportFile).toHaveBeenCalledTimes(1));
    expect(lastOptions()).toMatchObject({ transcript: false });
  });

  it("counts the files rather than implying one", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));

    // Summary and transcript are two documents, not one with a heading between
    // them. The count is how somebody notices before pressing the button.
    expect(screen.getByText(/2 files to export/)).toBeInTheDocument();
  });

  it("says when the selection will arrive as one archive", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));

    // Told beforehand, because a .zip nobody expected looks like the wrong
    // thing downloaded.
    expect(screen.getByText(/bundled as one \.zip/)).toBeInTheDocument();
  });

  it("counts the recording as part of the archive", async () => {
    // It used to be counted here and delivered separately, so "3 files,
    // bundled as one .zip" produced an archive containing two.
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.getByText("3 files to export, bundled as one .zip")).toBeInTheDocument();
  });

  it("does not promise an archive for a single file", async () => {
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("switch", { name: "Summary" }));

    expect(screen.getByText("1 file to export")).toBeInTheDocument();
  });

  it("asks for each part separately", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // Two requests, because they are two documents with two sets of options —
    // and because one failing must not lose the other.
    await waitFor(() => expect(fetchExportFile).toHaveBeenCalledTimes(2));
    expect(transcriptCall()).toMatchObject({ transcript: true, summary: false });
  });

  it("sends no section list when every section is wanted", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // Naming them all and naming none are the same request, and the empty one
    // survives a summary being rewritten under an open dialog.
    await waitFor(() => expect(fetchExportFile).toHaveBeenCalled());
    expect(lastOptions()).toMatchObject({ sections: [] });
  });

  it("names the sections once one is unticked", async () => {
    open();

    await userEvent.click(screen.getByRole("checkbox", { name: "Outline" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(fetchExportFile).toHaveBeenCalled());
    expect(lastOptions().sections).toEqual(["overview"]);
  });

  it("will not export nothing", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it("gives each part its own format", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.selectOptions(screen.getByLabelText("Summary file format"), "pdf");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // A PDF brief to send and a plain-text transcript to grep is a normal pair
    // of wants, and one format for both makes it two exports.
    await waitFor(() => expect(fetchExportFile).toHaveBeenCalledTimes(2));
    expect(fetchExportFile.mock.calls[0][1]).toBe("pdf");
    expect(fetchExportFile.mock.calls[1][1]).toBe("txt");
  });
});

/** Read the archive a `save` call was given, and list what is in it. */
async function archiveEntries(blob: Blob): Promise<string[]> {
  const view = new DataView(await blob.arrayBuffer());
  // The end-of-central-directory record is the last 22 bytes: total entries at
  // +10, the directory's offset at +16.
  const count = view.getUint16(view.byteLength - 22 + 10, true);
  let at = view.getUint32(view.byteLength - 22 + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(new Uint8Array(view.buffer, at + 46, nameLength)));
    at += 46 + nameLength;
  }
  return names;
}

/** The stored bytes of one entry, found through its local header. */
async function archiveEntryBytes(blob: Blob, index: number): Promise<Uint8Array> {
  const view = new DataView(await blob.arrayBuffer());
  let at = 0;
  for (let i = 0; i < index; i++) {
    at += 30 + view.getUint16(at + 26, true) + view.getUint32(at + 18, true);
  }
  const nameLength = view.getUint16(at + 26, true);
  const size = view.getUint32(at + 18, true);
  return new Uint8Array(view.buffer, at + 30 + nameLength, size);
}

describe("ExportDialog delivering the files", () => {
  it("hands the browser one download for one document", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning.txt");
  });

  it("hands the browser one .mp3 for audio on its own", async () => {
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("switch", { name: "Summary" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning.mp3");
    // Not an archive: one thing selected is one file.
    expect((save.mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
  });

  it("hands the browser one archive for two documents", async () => {
    // The reliability fix. Two synthetic clicks in a row is what browsers
    // block, and they block it silently — Chrome prompts once per origin and
    // drops everything after the first if the prompt is denied or dismissed.
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.pdf", "summary"))
      .mockResolvedValueOnce(document_("sprint-planning.txt", "transcript"));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning-summary-export.zip");
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-transcript.txt",
    ]);
  });

  it("hands the browser one archive for a summary and the recording", async () => {
    fetchExportFile.mockResolvedValue(document_("sprint-planning.pdf", "summary"));
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-audio.mp3",
    ]);
  });

  it("hands the browser one archive for all three", async () => {
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.pdf", "summary"))
      .mockResolvedValueOnce(document_("sprint-planning.txt", "transcript"));
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-transcript.txt",
      "sprint-planning-audio.mp3",
    ]);
  });

  it("puts real MPEG audio in the archive, not a renamed webm", async () => {
    // The claim the whole MP3 feature rests on, asserted on the bytes that
    // actually land in the file the user receives. Written by the real
    // bundler, so this is the archive rather than a stand-in for it.
    fetchExportFile.mockResolvedValue(document_("sprint-planning.pdf", "summary"));
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const archive = save.mock.calls[0][0] as Blob;
    expect((await archiveEntries(archive))[1]).toMatch(/\.mp3$/);
    const bytes = await archiveEntryBytes(archive, 1);
    // 0xFF 0xFB is an MPEG-1 Layer III frame sync. A webm starts 0x1A 0x45.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfb]);
  });

  it("closes only when everything asked for arrived", async () => {
    const onOpenChange = vi.fn();
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cannot be started twice by two clicks in the same tick", async () => {
    /*
     * The guard that `disabled={busy}` cannot provide. Disabling happens on the
     * next render, so two clicks dispatched inside one batch both find an
     * enabled button and both reach the handler -- which on a slow machine is
     * two of everything: two renders of the same document, two downloads, two
     * conversions.
     *
     * Dispatched directly rather than through `userEvent`, because awaiting a
     * click lets React paint in between and the second one lands on a button
     * that is already disabled. That is worth having too (below) and is a
     * different defence; this one is about the race underneath it.
     */
    let release: (v: unknown) => void = () => {};
    fetchExportFile.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    open();

    const button = screen.getByRole("button", { name: "Export" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchExportFile).toHaveBeenCalledTimes(1);
    release(document_("sprint-planning.txt"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("disables the button while an export is running", async () => {
    // The visible half of the same rule, and the one a user relies on: no
    // second attempt while the first is still going.
    fetchExportFile.mockImplementation(() => new Promise(() => {}));
    open();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Exporting/ })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });
});

describe("ExportDialog transcript layout", () => {
  it("passes the layout choices to the server", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Show timestamps" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Combine paragraphs of the same speaker" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(transcriptCall()).toBeTruthy());
    expect(transcriptCall()).toMatchObject({ timestamps: false, combine: "speaker" });
  });

  it("treats the two combine options as one choice", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Combine paragraphs of the same speaker" }),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Combine all paragraphs" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // They are mutually exclusive: "all" already includes "same speaker", and
    // sending both would leave the server to guess which was meant.
    await waitFor(() => expect(transcriptCall()).toBeTruthy());
    expect(transcriptCall()).toMatchObject({ combine: "all" });
  });

  it("offers nothing to include when there is no transcript", () => {
    open({ transcriptLines: 0 });

    expect(screen.getByRole("switch", { name: "Transcript" })).toBeDisabled();
    expect(screen.getByText(/no transcript for this meeting/i)).toBeInTheDocument();
  });
});

describe("ExportDialog preview", () => {
  it("shows what the summary file will contain", () => {
    open();

    expect(screen.getByText("We agreed to move billing to Stripe.")).toBeInTheDocument();
    expect(screen.getByText("Stripe won on fees")).toBeInTheDocument();
  });

  it("drops a section from the preview the moment it is unticked", async () => {
    open();

    await userEvent.click(screen.getByRole("checkbox", { name: "Outline" }));

    // A preview that ignores a tickbox is worse than no preview: it is
    // evidence for the wrong answer.
    expect(screen.queryByText("Stripe won on fees")).not.toBeInTheDocument();
    expect(screen.getByText("We agreed to move billing to Stripe.")).toBeInTheDocument();
  });

  it("shows the transcript laid out as the options ask", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(screen.getByText("[00:00] Priya")).toBeInTheDocument();
  });

  it("drops the timestamps from the preview too", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Show timestamps" }));
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(screen.queryByText("[00:00] Priya")).not.toBeInTheDocument();
    // Twice, because Priya speaks twice and nothing is being merged — the
    // labels are all that changed.
    expect(screen.getAllByText("Priya")).toHaveLength(2);
  });

  it("says so when there is nothing to preview", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText(/nothing to preview/i)).toBeInTheDocument();
  });
});

describe("ExportDialog the recording", () => {
  it("offers no choice of format, because there is only one", async () => {
    // Original is gone. Reverie stores whatever was uploaded, and handing that
    // back was offering somebody a webm their music player may refuse.
    open({ hasAudio: true, audioContentType: "audio/webm;codecs=opus" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.queryByLabelText("Audio format")).toBeNull();
    expect(screen.queryByRole("option", { name: /original/i })).toBeNull();
    expect(screen.queryByText(/webm/i)).toBeNull();
  });

  it("says the format is MP3", async () => {
    open({ hasAudio: true, audioContentType: "audio/webm;codecs=opus" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.getByText("MP3")).toBeInTheDocument();
  });

  it("always takes the MP3 path", async () => {
    open({ hasAudio: true, audioContentType: "audio/webm;codecs=opus" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(fetchMp3).toHaveBeenCalledWith("mtg_1"));
  });

  it("offers nothing for a meeting that was never a recording", () => {
    open({ hasAudio: false });

    expect(screen.getByRole("switch", { name: "Audio" })).toBeDisabled();
    expect(screen.getByText(/no stored recording/i)).toBeInTheDocument();
  });

  it("does not ask for audio for a document-only meeting even if everything else is chosen", async () => {
    open({ hasAudio: false });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(fetchMp3).not.toHaveBeenCalled();
  });
});
describe("ExportDialog exporting an MP3", () => {
  function openWithAudio(props: Partial<React.ComponentProps<typeof ExportDialog>> = {}) {
    return open({ hasAudio: true, audioContentType: "audio/webm;codecs=opus", ...props });
  }

  /** Audio alone, so the export produces the .mp3 rather than an archive. */
  async function audioOnly() {
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("switch", { name: "Summary" }));
  }

  it("warns that the first conversion takes a moment", async () => {
    openWithAudio();

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.getByText(/converted the first time/i)).toBeInTheDocument();
  });

  it("says nothing about converting when the recording is already an MP3", async () => {
    // There is nothing to wait for -- the endpoint presigns the stored object --
    // and promising a wait that will not happen is its own small dishonesty.
    openWithAudio({ audioContentType: "audio/mpeg" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.queryByText(/converted the first time/i)).not.toBeInTheDocument();
  });

  it("fetches the converted file from the signed storage URL, not from the API", async () => {
    // The whole point of the presigned link: the recording goes browser to
    // bucket. Spring never sees the bytes, which is what stops an export
    // tying up a request thread for the length of a download.
    openWithAudio();
    await audioOnly();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(fetchSignedFile).toHaveBeenCalledWith(
        "https://r2/signed.mp3",
        "sprint-planning.mp3",
      ),
    );
  });

  it("says it is preparing while the conversion runs", async () => {
    let answer: (v: unknown) => void = () => {};
    fetchMp3.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    openWithAudio();
    await audioOnly();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(screen.getByText("Preparing MP3…")).toBeInTheDocument());
    answer(READY_MP3);
    await waitFor(() => expect(save).toHaveBeenCalled());
  });

  it("builds no archive until the conversion says ready", async () => {
    // The ordering that makes the promise true: an archive assembled while the
    // MP3 was still converting would be an archive missing the MP3.
    let answer: (v: unknown) => void = () => {};
    fetchMp3.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    fetchExportFile.mockResolvedValue(document_("sprint-planning.pdf", "summary"));
    openWithAudio();
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByText("Preparing MP3…")).toBeInTheDocument());

    // The summary has already been fetched and is being held. Nothing has been
    // handed to the browser.
    expect(fetchExportFile).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    answer(READY_MP3);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toHaveLength(2);
  });

  it("downloads nothing when the conversion fails", async () => {
    fetchMp3.mockResolvedValue({
      status: "failed",
      url: null,
      expiresInSeconds: 0,
      message: "This recording has no audio to convert.",
    });
    const onOpenChange = vi.fn();
    openWithAudio({ onOpenChange });
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This recording has no audio to convert.",
      ),
    );
    // The summary arrived and is still not delivered: all of it, or none.
    expect(save).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("can be retried after a conversion failure and produces one archive", async () => {
    fetchMp3.mockResolvedValueOnce({
      status: "failed",
      url: null,
      expiresInSeconds: 0,
      message: "The audio could not be converted.",
    });
    fetchExportFile.mockResolvedValue(document_("sprint-planning.pdf", "summary"));
    openWithAudio();
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-audio.mp3",
    ]);
  });

  it("asks again for a link that has expired rather than following it", async () => {
    // Presigned URLs are short-lived by design, and a retry after a failure is
    // exactly the case where enough time has passed. Following a dead one
    // starts a download that fails partway with a message about a token.
    fetchMp3
      .mockResolvedValueOnce({ ...READY_MP3, expiresInSeconds: 0 })
      .mockResolvedValueOnce({ ...READY_MP3, url: "https://r2/fresh.mp3" });
    fetchSignedFile.mockRejectedValueOnce(new DownloadFailure(403));
    openWithAudio();
    await audioOnly();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetchSignedFile).toHaveBeenLastCalledWith(
      "https://r2/fresh.mp3",
      "sprint-planning.mp3",
    );
  });

  it("does not ask again for a link that is still good", async () => {
    // The conversion is the expensive half. A second export in the same dialog
    // should cost a fetch, not another poll.
    fetchSignedFile.mockRejectedValueOnce(new DownloadFailure(500));
    openWithAudio();
    await audioOnly();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fetchMp3.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(fetchMp3).not.toHaveBeenCalled();
  });
});

describe("ExportDialog language", () => {
  it("writes the file in whatever the page is being read in", async () => {
    open({ language: "es", languageName: "Spanish" });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // A Spanish summary exported as English looks like a working file right up
    // until somebody who reads only Spanish opens it.
    await waitFor(() => expect(fetchExportFile).toHaveBeenCalled());
    expect(lastOptions()).toMatchObject({ language: "es" });
  });

  it("says the recording was not translated", () => {
    open({ language: "es", languageName: "Spanish", sourceLanguageName: "English" });

    expect(screen.getByText(/not a second transcription/i)).toBeInTheDocument();
  });
});

describe("ExportDialog when it fails", () => {
  it("says what the server said", async () => {
    // `ExportError` is the type the fetch layer throws when the API wrote a
    // sentence meant to be read. Those are shown as they are.
    fetchExportFile.mockRejectedValue(
      new ExportError("This meeting has not been translated into German"),
    );
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This meeting has not been translated into German",
      ),
    );
  });

  it("does not put a transport failure in front of anybody", async () => {
    // "Failed to fetch", "Download failed (500)", "NetworkError when attempting
    // to fetch resource" -- all true, none of them something to act on, and all
    // of them read as the app leaking rather than as an answer.
    fetchExportFile.mockRejectedValue(new TypeError("Failed to fetch"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const said = toastError.mock.calls[0][0] as string;
    expect(said).toContain("Couldn't export the summary");
    expect(said).not.toMatch(/fetch|\d{3}\b/i);
  });

  it("names the part that failed rather than the meeting", async () => {
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt"))
      .mockRejectedValueOnce(new DownloadFailure(500));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toContain("Couldn't export the transcript");
  });

  it("downloads nothing when the summary fails", async () => {
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // The user asked for two files. One handed over without comment is the
    // quiet failure this change exists to remove, so neither is.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
  });

  it("stops fetching once a part has failed", async () => {
    // Nothing after a failure can be delivered, so nothing after it is asked
    // for. It matters most for the recording, which is last and can take
    // minutes to convert -- continuing would leave somebody watching
    // "Preparing MP3…" for a file that was never going to be handed over.
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(fetchExportFile).toHaveBeenCalledTimes(1);
    expect(fetchMp3).not.toHaveBeenCalled();
  });

  it("downloads nothing when the transcript fails", async () => {
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt"))
      .mockRejectedValueOnce(new DownloadFailure(500));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
  });

  it("downloads nothing when the recording fails", async () => {
    fetchSignedFile.mockRejectedValue(new DownloadFailure(500));
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
  });

  it("never claims a partial success", async () => {
    // The wording is gone because the behaviour is. There is no path on which
    // some of a selection is delivered, so there is nothing to count.
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt"))
      .mockRejectedValueOnce(new DownloadFailure(500));
    const onOpenChange = vi.fn();
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText(/of 2 downloaded/)).toBeNull();
    // Closing is how this dialog says "done", so it must not close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("says plainly that nothing was downloaded", async () => {
    // A toast lasts five seconds and takes the only record of which part failed
    // with it. The banner also has to answer the question the old wording left
    // open -- did some of it work?
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't export the summary.");
    expect(alert).toHaveTextContent(/nothing was downloaded/i);
    expect(alert).not.toHaveTextContent(/nothing else was affected/i);
  });

  it("stays open so the choice is not lost", async () => {
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    const onOpenChange = vi.fn();
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("can be retried without reconstructing the selection", async () => {
    fetchExportFile.mockRejectedValueOnce(new DownloadFailure(503));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.pdf"))
      .mockResolvedValueOnce(document_("sprint-planning.txt"));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // Both tickboxes survived the failure, so the retry produces the whole
    // archive rather than whatever was left selected.
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await archiveEntries(save.mock.calls[0][0] as Blob)).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-transcript.txt",
    ]);
  });
});
