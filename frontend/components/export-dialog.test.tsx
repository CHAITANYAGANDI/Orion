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
 * <p>And a fourth, added after export was reported as intermittent: <b>a part
 * that did not download must never look like one that did</b>. One failure must
 * not cancel the parts after it, the message must say which part, and the
 * choices must survive so the retry is a click rather than a reconstruction.
 */
const { fetchExportFile, openSignedDownload, save, fetchAudio, fetchMp3, toastError, toastSuccess } =
  vi.hoisted(() => ({
    fetchExportFile: vi.fn(),
    openSignedDownload: vi.fn(),
    save: vi.fn(),
    fetchAudio: vi.fn(),
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
  openSignedDownload: (...args: unknown[]) => openSignedDownload(...args),
  save: (...args: unknown[]) => save(...args),
}));

vi.mock("@/lib/api", () => ({
  API_BASE: "http://api.test",
  useLazyGetAudioDownloadQuery: () => [
    (id: string) => ({ unwrap: () => fetchAudio(id) }),
    { isFetching: false },
  ],
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

beforeEach(() => {
  vi.clearAllMocks();
  fetchExportFile.mockResolvedValue(document_("sprint-planning.txt"));
  fetchAudio.mockResolvedValue({ url: "https://minio/signed", filename: "a.m4a" });
  fetchMp3.mockResolvedValue(READY_MP3);
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

  it("says when the two documents will arrive as one archive", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));

    // Told beforehand, because a .zip nobody expected looks like the wrong
    // thing downloaded.
    expect(screen.getByText(/bundled as one \.zip/)).toBeInTheDocument();
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

describe("ExportDialog delivering the files", () => {
  it("hands the browser one download for one document", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning.txt");
  });

  it("hands the browser one archive for two documents", async () => {
    // The reliability fix. Two synthetic clicks in a row is what browsers
    // block, and they block it silently — Chrome prompts once per origin and
    // drops everything after the first if the prompt is denied or dismissed.
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt", "summary"))
      .mockResolvedValueOnce(document_("sprint-planning-transcript.md", "transcript"));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning.zip");
  });

  it("puts both requested files inside the archive", async () => {
    // Written by the real bundler, so this is the actual archive a user would
    // receive rather than a stand-in that agrees with the test.
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt", "summary"))
      .mockResolvedValueOnce(document_("sprint-planning-transcript.md", "transcript"));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const archive = new DataView(await (save.mock.calls[0][0] as Blob).arrayBuffer());
    expect(archive.getUint16(archive.byteLength - 12, true)).toBe(2);
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
  it("fetches the original audio alongside the documents", async () => {
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(fetchAudio).toHaveBeenCalledWith("mtg_1"));
    expect(openSignedDownload).toHaveBeenCalledWith("https://minio/signed");
  });

  it("names what Original will actually give you", async () => {
    open({ hasAudio: true, audioContentType: "audio/mp4" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    // The point of the label: Original hands over exactly what was uploaded,
    // and knowing that it is m4a is what makes the MP3 option a choice rather
    // than a discovery after the download.
    expect(screen.getByRole("option", { name: "Original (m4a)" })).toBeInTheDocument();
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
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(fetchMp3).not.toHaveBeenCalled();
  });
});

describe("ExportDialog exporting an MP3", () => {
  function openWithAudio(props: Partial<React.ComponentProps<typeof ExportDialog>> = {}) {
    return open({ hasAudio: true, audioContentType: "audio/webm;codecs=opus", ...props });
  }

  async function chooseMp3() {
    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.selectOptions(screen.getByLabelText("Audio format"), "mp3");
  }

  it("offers Original and MP3", async () => {
    openWithAudio();

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    expect(screen.getByRole("option", { name: /^Original/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "MP3" })).toBeInTheDocument();
  });

  it("defaults to the original, so nothing is converted by accident", async () => {
    openWithAudio();

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(fetchAudio).toHaveBeenCalled());
    expect(fetchMp3).not.toHaveBeenCalled();
  });

  it("warns that the first conversion takes a moment", async () => {
    openWithAudio();
    await chooseMp3();

    expect(screen.getByText(/converted the first time/i)).toBeInTheDocument();
  });

  it("says nothing about converting when the recording is already an MP3", async () => {
    openWithAudio({ audioContentType: "audio/mpeg" });
    await chooseMp3();

    // There is nothing to wait for, and promising a wait that will not happen
    // is its own small dishonesty.
    expect(screen.queryByText(/converted the first time/i)).not.toBeInTheDocument();
  });

  it("downloads the converted file without being asked twice", async () => {
    openWithAudio();
    await chooseMp3();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(openSignedDownload).toHaveBeenCalledWith("https://r2/signed.mp3"));
  });

  it("says it is preparing while the conversion runs", async () => {
    let answer: (v: unknown) => void = () => {};
    fetchMp3.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    openWithAudio();
    await chooseMp3();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(screen.getByText("Preparing MP3…")).toBeInTheDocument());
    answer(READY_MP3);
    await waitFor(() => expect(openSignedDownload).toHaveBeenCalled());
  });

  it("keeps offering the file without reopening the dialog", async () => {
    // The dialog only stays open when something else failed, so the button is
    // for exactly that case: take the recording you waited for while retrying
    // the part that did not work.
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    openWithAudio();
    await chooseMp3();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /download mp3/i })).toBeInTheDocument(),
    );
    openSignedDownload.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /download mp3/i }));

    await waitFor(() => expect(openSignedDownload).toHaveBeenCalledWith("https://r2/signed.mp3"));
  });

  it("replaces a link that has expired rather than following it", async () => {
    // Presigned URLs are short-lived by design, and the case the button exists
    // for — coming back to retry — is exactly the case where enough time has
    // passed. Following a dead one starts a download that fails partway with a
    // message about a token, which reads as the recording being gone.
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    fetchMp3.mockResolvedValueOnce({ ...READY_MP3, expiresInSeconds: 0 });
    openWithAudio();
    await chooseMp3();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /download mp3/i })).toBeInTheDocument(),
    );
    fetchMp3.mockResolvedValue({ ...READY_MP3, url: "https://r2/fresh.mp3" });
    await userEvent.click(screen.getByRole("button", { name: /download mp3/i }));

    await waitFor(() => expect(openSignedDownload).toHaveBeenCalledWith("https://r2/fresh.mp3"));
  });

  it("does not re-ask for a link that is still good", async () => {
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    openWithAudio();
    await chooseMp3();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /download mp3/i })).toBeInTheDocument(),
    );
    fetchMp3.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /download mp3/i }));

    await waitFor(() => expect(openSignedDownload).toHaveBeenCalledTimes(2));
    expect(fetchMp3).not.toHaveBeenCalled();
  });

  it("explains a conversion that failed, and leaves a way to try again", async () => {
    fetchMp3.mockResolvedValue({
      status: "failed",
      url: null,
      expiresInSeconds: 0,
      message: "This recording has no audio to convert.",
    });
    const onOpenChange = vi.fn();
    openWithAudio({ onOpenChange });
    await chooseMp3();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("This recording has no audio to convert."),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("keeps the summary that did arrive when the conversion fails", async () => {
    fetchMp3.mockResolvedValue({ status: "failed", url: null, expiresInSeconds: 0 });
    openWithAudio();
    await chooseMp3();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning.txt");
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

  it("still delivers the part that worked", async () => {
    // The bug, at the level a user sees it: asking for two things and getting
    // neither because one of them failed.
    fetchExportFile
      .mockRejectedValueOnce(new DownloadFailure(500))
      .mockResolvedValueOnce(document_("sprint-planning-transcript.md"));
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe("sprint-planning-transcript.md");
  });

  it("does not report a partial export as a success", async () => {
    fetchExportFile
      .mockResolvedValueOnce(document_("sprint-planning.txt"))
      .mockRejectedValueOnce(new DownloadFailure(500));
    const onOpenChange = vi.fn();
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Closing is how this dialog says "done", so it must not close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // And it says plainly how much arrived, because somebody who only read the
    // error will assume none of it did.
    expect(toastSuccess).toHaveBeenCalledWith("1 of 2 downloaded.");
  });

  it("leaves the failure on screen after the toast has gone", async () => {
    // A toast lasts five seconds and takes the only record of which part failed
    // with it.
    fetchExportFile.mockRejectedValue(new DownloadFailure(500));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't export the summary."),
    );
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

    fetchExportFile.mockResolvedValue(document_("sprint-planning.txt"));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // Still two documents: the tickboxes survived the failure.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(fetchExportFile.mock.calls.filter((c) => (c[2] as { transcript?: boolean }).transcript))
      .toHaveLength(2);
  });
});
