import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The download dialog.
 *
 * <p>These tests guard the two things a download can get wrong without saying
 * so. It can be the wrong size — a forty-page transcript when somebody wanted a
 * two-page brief to attach to an email, or the brief when they wanted the
 * record — and it can be in the wrong language, which is worse: a Spanish
 * summary exported as English looks like a working file until somebody who
 * reads only Spanish opens it.
 *
 * <p>The rest is about the recording, which is deliberately not a fifth format:
 * it is fetched from storage rather than rendered, and it does not exist at all
 * for a meeting imported as a document.
 */
const { downloadExport, openSignedDownload, fetchAudio, toastError } = vi.hoisted(() => ({
  downloadExport: vi.fn(),
  openSignedDownload: vi.fn(),
  fetchAudio: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/exports", () => ({
  downloadExport: (...args: unknown[]) => downloadExport(...args),
  openSignedDownload: (...args: unknown[]) => openSignedDownload(...args),
}));

vi.mock("@/lib/api", () => ({
  useLazyGetAudioDownloadQuery: () => [
    (id: string) => {
      fetchAudio(id);
      return { unwrap: () => Promise.resolve({ url: "https://minio/signed", filename: "a.mp3" }) };
    },
    { isFetching: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { ExportDialog } from "@/components/export-dialog";

function open(props: Partial<React.ComponentProps<typeof ExportDialog>> = {}) {
  return render(
    <ExportDialog
      open
      onOpenChange={vi.fn()}
      meetingId="mtg_1"
      transcriptLines={412}
      {...props}
    />,
  );
}

/** The options the last download was asked for. */
function lastOptions() {
  return downloadExport.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  downloadExport.mockResolvedValue(undefined);
});

describe("ExportDialog formats", () => {
  it("offers the four Recallix writes", () => {
    open();

    expect(screen.getByRole("radio", { name: /PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Word/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Markdown/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Plain text/ })).toBeInTheDocument();
  });

  it("starts on PDF", () => {
    open();

    // "Send me the notes" almost always means a PDF, and a default nobody has
    // to change is one fewer click on the most common path.
    expect(screen.getByRole("radio", { name: /PDF/ })).toHaveAttribute("aria-checked", "true");
  });

  it("downloads the format that was chosen", async () => {
    open();

    await userEvent.click(screen.getByRole("radio", { name: /Word/ }));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith("mtg_1", "docx", expect.anything()));
  });
});

describe("ExportDialog the transcript", () => {
  it("leaves it out by default", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(lastOptions().transcript).toBe(false));
  });

  it("says how much there is to include", () => {
    open();

    // "412 lines" is what tells somebody this is the difference between two
    // pages and forty.
    expect(screen.getByText(/412 lines/)).toBeInTheDocument();
  });

  it("includes it when asked", async () => {
    open();

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(lastOptions().transcript).toBe(true));
  });

  it("offers nothing to include when there is no transcript", () => {
    open({ transcriptLines: 0 });

    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument();
  });
});

describe("ExportDialog language", () => {
  it("writes the file in whatever the page is being read in", async () => {
    open({ language: "es", languageName: "Spanish" });

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    // No second choice of language here on purpose: exporting the English while
    // looking at the Spanish is a mistake nobody would notice until later.
    await waitFor(() => expect(lastOptions().language).toBe("es"));
  });

  it("says the recording was not translated", () => {
    open({ language: "es", languageName: "Spanish", sourceLanguageName: "English" });

    expect(screen.getByText(/recording is still in English/i)).toBeInTheDocument();
  });

  it("says nothing about language when reading the original", () => {
    open({ language: null });

    expect(screen.queryByText(/Written in/)).not.toBeInTheDocument();
  });
});

describe("ExportDialog the recording", () => {
  it("offers the original audio alongside the documents", async () => {
    open({ hasAudio: true });

    await userEvent.click(screen.getByRole("button", { name: /Audio/ }));

    // Fetched on click: the link is signed and expires, so one taken when the
    // page loaded would be dead by the time somebody came back to the tab.
    await waitFor(() => expect(fetchAudio).toHaveBeenCalledWith("mtg_1"));
    await waitFor(() => expect(openSignedDownload).toHaveBeenCalledWith("https://minio/signed"));
  });

  it("offers nothing for a meeting that was never a recording", () => {
    open({ hasAudio: false });

    expect(screen.queryByRole("button", { name: /Audio/ })).not.toBeInTheDocument();
  });
});

describe("ExportDialog when it fails", () => {
  it("says what the server said", async () => {
    downloadExport.mockRejectedValue(new Error("This meeting has not been translated into German"));
    open();

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    // The API's message is the useful one; "Export failed" leaves somebody
    // clicking the same button again.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This meeting has not been translated into German",
      ),
    );
  });

  it("stays open so the choice is not lost", async () => {
    const onOpenChange = vi.fn();
    downloadExport.mockRejectedValue(new Error("nope"));
    open({ onOpenChange });

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
