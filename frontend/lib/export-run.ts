/**
 * Running an export, one part at a time, so one failure is one failure.
 *
 * <h2>The bug this replaces</h2>
 *
 * <p>The dialog awaited the summary, then the transcript, then the audio,
 * inside a single `try`. Three consequences, all of which were reported as
 * "sometimes the export doesn't work":
 *
 * <ul>
 *   <li>A summary that failed <b>cancelled the transcript and the audio</b>. The
 *       user had asked for three files and got none, with nothing on screen
 *       saying that two of them were never attempted.</li>
 *   <li>The message was "Couldn't export this meeting", which does not say
 *       <em>which</em> — leaving somebody to work it out from their downloads
 *       folder.</li>
 *   <li>Two documents meant two synthetic link clicks in a row, which browsers
 *       treat as a site pushing files at you and drop silently after the first.
 *       That one is why the documents are collected and delivered together.</li>
 * </ul>
 *
 * <h2>The shape</h2>
 *
 * <p>Every part is attempted regardless of what the parts before it did. Then
 * whatever was actually fetched is delivered: one document as itself, several as
 * one archive. What comes back is a list of what arrived and a list of what did
 * not, and the caller decides what to say — this module never touches a toast,
 * a dialog or the DOM, which is what makes the whole of it testable.
 *
 * <p>The IO it does need is injected for the same reason. `save` and the
 * archive builder are the only parts that need a browser.
 */

import {
  buildBundle,
  bundleName as defaultBundleName,
  describeExportFailure,
  save as defaultSave,
  type ExportFile,
  type ExportPart,
} from "@/lib/exports";

export interface DocumentRequest {
  /** Which part this is, for naming a failure the user can act on. */
  part: Exclude<ExportPart, "audio">;
  fetch: () => Promise<ExportFile>;
}

export interface ExportPlan {
  documents: DocumentRequest[];
  /**
   * The recording, which is delivered rather than fetched: it goes straight
   * from object storage to the browser and never passes through this tab. A
   * hundred-megabyte recording pulled into memory to be handed back is slower
   * and can take the tab with it.
   */
  audio?: () => Promise<void>;
}

export interface ExportFailure {
  part: ExportPart;
  /** Already user-facing. Never a status code, a URL or a stack. */
  message: string;
}

export interface ExportOutcome {
  /**
   * What was handed to the browser.
   *
   * <p>For the documents that means the bytes arrived and a download was
   * started. For the audio it means the browser was sent to a working signed
   * link — whether the file finishes downloading is between the browser and
   * object storage, and this tab never learns the answer. Saying so is better
   * than pretending to know.
   */
  delivered: ExportPart[];
  failures: ExportFailure[];
  /** Nothing failed. The dialog closes on this and stays open otherwise. */
  complete: boolean;
}

export interface ExportIo {
  save: (blob: Blob, filename: string) => void;
  bundle: (files: ExportFile[]) => Promise<Blob>;
  bundleName: (files: ExportFile[]) => string;
  pause: (ms: number) => Promise<void>;
}

/**
 * A gap between the archive and the recording.
 *
 * <p>Two downloads is the floor when somebody asks for documents and audio: the
 * recording cannot go in the archive without pulling it through the tab, which
 * is the thing the presigned link exists to avoid. Spacing them is what keeps
 * the second from being read as the automatic-multiple-download pattern
 * browsers throttle.
 */
export const STAGGER_MS = 700;

const defaultIo: ExportIo = {
  save: defaultSave,
  bundle: buildBundle,
  bundleName: defaultBundleName,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function runExport(
  plan: ExportPlan,
  io: ExportIo = defaultIo,
): Promise<ExportOutcome> {
  const delivered: ExportPart[] = [];
  const failures: ExportFailure[] = [];
  const fetched: { part: ExportPart; file: ExportFile }[] = [];

  // Sequential rather than parallel, and on purpose: two renders of the same
  // meeting at once double the load on the export endpoint for no gain a user
  // can perceive, and rendering a forty-page transcript is not cheap. What
  // matters is that a rejection here is caught here.
  for (const document of plan.documents) {
    try {
      fetched.push({ part: document.part, file: await document.fetch() });
    } catch (error) {
      failures.push({
        part: document.part,
        message: describeExportFailure(document.part, error),
      });
    }
  }

  if (fetched.length === 1) {
    io.save(fetched[0].file.blob, fetched[0].file.filename);
    delivered.push(fetched[0].part);
  } else if (fetched.length > 1) {
    const files = fetched.map((entry) => entry.file);
    try {
      io.save(await io.bundle(files), io.bundleName(files));
      delivered.push(...fetched.map((entry) => entry.part));
    } catch {
      // The archive could not be built. Every document is in hand and giving
      // them up over the packaging would be the worst outcome available, so
      // this falls back to the old way — separate downloads, spaced out. The
      // browser may still refuse the second, which is exactly why it is the
      // fallback and not the plan.
      for (const [index, entry] of fetched.entries()) {
        if (index > 0) await io.pause(STAGGER_MS);
        io.save(entry.file.blob, entry.file.filename);
        delivered.push(entry.part);
      }
    }
  }

  if (plan.audio) {
    if (delivered.length > 0) await io.pause(STAGGER_MS);
    try {
      await plan.audio();
      delivered.push("audio");
    } catch (error) {
      failures.push({ part: "audio", message: describeExportFailure("audio", error) });
    }
  }

  return { delivered, failures, complete: failures.length === 0 };
}
