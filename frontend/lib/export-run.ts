/**
 * Running an export: everything, or nothing.
 *
 * <h2>What this used to do, and why it was wrong</h2>
 *
 * <p>The first version of this file fixed a real bug — the dialog awaited the
 * summary, then the transcript, then the audio inside one `try`, so a failed
 * summary silently cancelled the other two. The fix was to run each part
 * independently and report what arrived.
 *
 * <p>It fixed the wrong half. Independent parts meant <em>partial</em>
 * delivery: somebody who ticked three things could receive two, be told "2 of 3
 * downloaded", and be left to work out which two. It also meant the recording
 * was delivered separately from the documents, so a dialog that said "3 files,
 * bundled as one .zip" produced an archive with two things in it and a second
 * download that might never arrive.
 *
 * <p>Partial success is a worse failure mode than total failure, because it is
 * quiet. A user who gets nothing knows to try again; a user who gets an archive
 * missing the recording finds out weeks later, if at all.
 *
 * <h2>What it does now</h2>
 *
 * <ol>
 *   <li>Fetch the selected parts in order, stopping at the first failure. The
 *       failure is attributed to the part that caused it, which is what the
 *       original single-`try` version could not do.</li>
 *   <li><b>If anything failed, deliver nothing.</b> No archive, no individual
 *       file, no download of any kind. The caller keeps the dialog open with the
 *       selections intact and shows which part failed.</li>
 *   <li>One part: hand it over as itself. A single summary should not arrive
 *       inside an archive.</li>
 *   <li>Two or more: exactly one archive containing exactly those parts.</li>
 * </ol>
 *
 * <p><b>Why stopping is right here, when carrying on was right before.</b> The
 * earlier version continued past a failure so it could report every part that
 * went wrong, and that made sense while parts were delivered independently.
 * Nothing is delivered now unless all of it is, so the only thing continuing
 * buys is a longer list of failures — and the recording is last and can take
 * minutes to convert. Continuing would mean a summary that failed instantly
 * leaves somebody watching "Preparing MP3…" for five minutes before being told
 * about the summary, for a conversion whose result is thrown away. One clear
 * failure, quickly, beats a complete list nobody asked for.
 *
 * <p>Nothing here touches a toast, a dialog or the DOM, which is what makes all
 * of it testable. The IO it does need — saving a file, building an archive — is
 * injected for the same reason.
 */

import {
  buildBundle,
  bundleName as defaultBundleName,
  describeExportFailure,
  entryName,
  save as defaultSave,
  type ExportFile,
  type ExportPart,
} from "@/lib/exports";

export interface ExportItem {
  /** Which part this is: for naming a failure, and for naming it in the archive. */
  part: ExportPart;
  /**
   * Get the bytes.
   *
   * <p>The recording is a `fetch` too now, not a navigation. It still comes
   * straight from object storage rather than through the API — but an export
   * that promises all-or-nothing has to know the audio arrived, and a
   * navigation to a signed URL cannot be observed from here.
   */
  fetch: () => Promise<ExportFile>;
}

export interface ExportPlan {
  items: ExportItem[];
}

export interface ExportFailure {
  /**
   * Which part could not be produced, or null when the export as a whole
   * failed after every part had arrived — packaging them into one archive is
   * the only thing that can do that, and blaming it on the summary would be a
   * small lie in the one message the user has to go on.
   */
  part: ExportPart | null;
  /** Already user-facing. Never a status code, a URL or a stack. */
  message: string;
}

export interface ExportOutcome {
  /** What was handed to the browser: everything, or nothing at all. */
  delivered: ExportPart[];
  failures: ExportFailure[];
  /** Nothing failed. The dialog closes on this and stays open otherwise. */
  complete: boolean;
}

export interface ExportIo {
  save: (blob: Blob, filename: string) => void;
  bundle: (files: ExportFile[]) => Promise<Blob>;
  bundleName: (files: ExportFile[]) => string;
}

const defaultIo: ExportIo = {
  save: defaultSave,
  bundle: buildBundle,
  bundleName: defaultBundleName,
};

export async function runExport(
  plan: ExportPlan,
  io: ExportIo = defaultIo,
): Promise<ExportOutcome> {
  const failures: ExportFailure[] = [];
  const fetched: { part: ExportPart; file: ExportFile }[] = [];

  /*
   * Sequential rather than parallel, and on purpose: rendering a forty-page
   * transcript is not cheap, and two renders of the same meeting at once double
   * the load on the export endpoint for no gain a user can perceive.
   *
   * The order the caller passes matters, and it puts the recording last -- it is
   * the only part that can take minutes, so stopping early is worth most when
   * the thing being skipped is the conversion.
   */
  for (const item of plan.items) {
    try {
      fetched.push({ part: item.part, file: await item.fetch() });
    } catch (error) {
      failures.push({ part: item.part, message: describeExportFailure(item.part, error) });
      // Nothing after this can be delivered, so nothing after this is fetched.
      break;
    }
  }

  if (failures.length > 0) {
    /*
     * Nothing is saved. Not the parts that succeeded, not an archive of them --
     * the user asked for a set, and half a set delivered without comment is the
     * quiet failure this is arranged to prevent. What they get instead is an
     * intact selection and a sentence naming the part that did not work.
     *
     * The bytes that did arrive are dropped here. They cost a second fetch on
     * retry, which is the right price: the alternative is holding a hundred
     * megabytes of audio against a retry that may never come.
     */
    return { delivered: [], failures, complete: false };
  }

  if (fetched.length === 1) {
    const only = fetched[0];
    io.save(only.file.blob, only.file.filename);
    return { delivered: [only.part], failures: [], complete: true };
  }

  if (fetched.length > 1) {
    // Named per part inside the archive: the server calls both documents after
    // the meeting, so two of them in the same format would otherwise collide.
    const files = fetched.map((entry) => ({
      blob: entry.file.blob,
      filename: entryName(entry.part, entry.file.filename),
    }));
    let archive: Blob;
    try {
      archive = await io.bundle(files);
    } catch {
      /*
       * Every part arrived and the packaging failed -- realistically, running
       * out of room for a very large recording. There is deliberately no
       * fallback to separate downloads: that is exactly the partial delivery
       * this function exists to prevent, and it would be triggered by the one
       * condition under which it is most likely to half-work.
       */
      return {
        delivered: [],
        failures: [{
          part: null,
          message: "Couldn't package your export into one file. Try again, "
            + "or export fewer things at once.",
        }],
        complete: false,
      };
    }
    io.save(archive, io.bundleName(files));
    return { delivered: fetched.map((entry) => entry.part), failures: [], complete: true };
  }

  // Nothing selected. Not a failure, and not a download either.
  return { delivered: [], failures: [], complete: true };
}
