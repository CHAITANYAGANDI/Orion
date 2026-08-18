import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
 * <p>The recording is deliberately not a fifth format. It is fetched from
 * storage rather than rendered, it is not transcoded, and it does not exist at
 * all for a meeting imported as a document.
 */
const { downloadExport, openSignedDownload, fetchAudio, toastError } = vi.hoisted(() => ({
  downloadExport: vi.fn(),
  openSignedDownload: vi.fn(),
  fetchAudio: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/exports", async (orig) => ({
  ...(await orig<typeof import("@/lib/exports")>()),
  downloadExport: (...args: unknown[]) => downloadExport(...args),
  openSignedDownload: (...args: unknown[]) => openSignedDownload(...args),
}));

vi.mock("@/lib/api", () => ({
  useLazyGetAudioDownloadQuery: () => [
    (id: string) => {
      fetchAudio(id);
      return { unwrap: () => Promise.resolve({ url: "https://minio/signed", filename: "a.m4a" }) };
    },
    { isFetching: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { ExportDialog } from "@/components/export-dialog";
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

/** The options the last download was asked for. */
function lastOptions() {
  return downloadExport.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

/** The options of the call that asked for the transcript. */
function transcriptCall() {
  return downloadExport.mock.calls.find(
    (c) => (c[2] as Record<string, unknown>)?.transcript === true,
  )?.[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  downloadExport.mockResolvedValue(undefined);
});

describe("ExportDialog choosing", () => {
  it("starts with the summary and without the transcript", async () => {
    open();

    expect(screen.getByText("1 file to export")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // The commonest export by a distance, and the one that fits in an email.
    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(1));
    expect(lastOptions()).toMatchObject({ transcript: false });
  });

  it("counts the files rather than implying one", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));

    // Summary and transcript are two documents, not one with a heading between
    // them. The count is how somebody notices before pressing the button.
    expect(screen.getByText("2 files to export")).toBeInTheDocument();
  });

  it("writes each part as its own file", async () => {
    open();

    await userEvent.click(screen.getByRole("switch", { name: "Transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(2));
    expect(transcriptCall()).toMatchObject({ transcript: true, summary: false });
  });

  it("sends no section list when every section is wanted", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // Naming them all and naming none are the same request, and the empty one
    // survives a summary being rewritten under an open dialog.
    await waitFor(() => expect(downloadExport).toHaveBeenCalled());
    expect(lastOptions()).toMatchObject({ sections: [] });
  });

  it("names the sections once one is unticked", async () => {
    open();

    await userEvent.click(screen.getByRole("checkbox", { name: "Outline" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(downloadExport).toHaveBeenCalled());
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
    await waitFor(() => expect(downloadExport).toHaveBeenCalledTimes(2));
    expect(downloadExport.mock.calls[0][1]).toBe("pdf");
    expect(downloadExport.mock.calls[1][1]).toBe("txt");
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

  it("names the format the recording actually is", async () => {
    open({ hasAudio: true, audioContentType: "audio/mp4" });

    await userEvent.click(screen.getByRole("switch", { name: "Audio" }));

    // Recallix does not transcode. Printing "mp3" would name a file the user
    // cannot open with whatever they downloaded it for.
    expect(screen.getByText("m4a")).toBeInTheDocument();
  });

  it("offers nothing for a meeting that was never a recording", () => {
    open({ hasAudio: false });

    expect(screen.getByRole("switch", { name: "Audio" })).toBeDisabled();
    expect(screen.getByText(/no stored recording/i)).toBeInTheDocument();
  });
});

describe("ExportDialog language", () => {
  it("writes the file in whatever the page is being read in", async () => {
    open({ language: "es", languageName: "Spanish" });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    // A Spanish summary exported as English looks like a working file right up
    // until somebody who reads only Spanish opens it.
    await waitFor(() => expect(downloadExport).toHaveBeenCalled());
    expect(lastOptions()).toMatchObject({ language: "es" });
  });

  it("says the recording was not translated", () => {
    open({ language: "es", languageName: "Spanish", sourceLanguageName: "English" });

    expect(screen.getByText(/not a second transcription/i)).toBeInTheDocument();
  });
});

describe("ExportDialog when it fails", () => {
  it("says what the server said", async () => {
    downloadExport.mockRejectedValue(new Error("This meeting has not been translated into German"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This meeting has not been translated into German",
      ),
    );
  });

  it("stays open so the choice is not lost", async () => {
    downloadExport.mockRejectedValue(new Error("nope"));
    const onOpenChange = vi.fn();
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
