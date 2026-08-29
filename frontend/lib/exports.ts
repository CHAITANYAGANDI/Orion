/**
 * Downloading a meeting.
 *
 * <p>The file is built by the server — see the export renderers — so this module
 * only has to ask for it and get it onto the disk. That is less trivial than it
 * sounds, for one reason: the request needs the session's auth header, and a
 * plain `<a href>` cannot carry one. So the bytes are fetched, turned into a
 * blob and handed to a synthetic link, which is also what lets the filename come
 * from `Content-Disposition` rather than from a guess made here.
 *
 * <h2>Why most of this file is about failure</h2>
 *
 * <p>Export was reported as intermittent: sometimes nothing arrived, and all the
 * screen said was "Couldn't export this meeting." Three separate faults were
 * producing that, and none of them were the network being flaky.
 *
 * <ol>
 *   <li><b>The object URL was revoked in the same tick as the click.</b>
 *       {@link save} called `URL.revokeObjectURL` immediately after
 *       `link.click()`. A browser starts the download asynchronously; revoking
 *       the URL before it has read it aborts the download with no error
 *       anywhere. It worked most of the time, which is the worst amount.</li>
 *   <li><b>Several programmatic downloads in a row are refused.</b> Choosing a
 *       summary and a transcript fired two synthetic clicks, and browsers treat
 *       that as a site pushing files at you — Chrome prompts once per origin and
 *       silently drops everything after the first if the prompt is denied or
 *       dismissed. Hence {@link buildBundle}: more than one selected item is one
 *       archive and one download — the recording included.</li>
 *   <li><b>One failure cancelled the exports after it.</b> The parts were
 *       awaited in sequence inside a single `try`, so a summary that failed took
 *       the transcript and the audio down with it — neither attempted, and
 *       nothing said so. That is fixed in `lib/export-run.ts`, which fetches
 *       every selected part before it delivers any of them.</li>
 * </ol>
 *
 * <p>Everything except {@link save} and {@link openSignedDownload} is pure or
 * injectable, so the awkward parts — the query string, the header parsing, the
 * retry rule and the wording of a failure — are testable without a browser.
 */

import { API_BASE } from "@/lib/api";
import { buildAuthHeaders } from "@/lib/auth-store";
import { zip } from "@/lib/zip";

export type ExportFormat = "pdf" | "docx" | "md" | "txt";

/** How much of the back-and-forth to flatten away. */
export type CombineMode = "none" | "speaker" | "all";

/** The three things a meeting can be taken away as, for naming a failure. */
export type ExportPart = "summary" | "transcript" | "audio";

export interface ExportOptions {
  /** The brief. Defaults to included, which is what the endpoint does. */
  summary?: boolean;
  /** Which summary sections, by key. Omitted or empty means all of them. */
  sections?: string[];
  /** What people agreed to do. Defaults to included. */
  actionItems?: boolean;
  /** The transcript is left out unless asked for; it is most of the file. */
  transcript?: boolean;
  /** Label each utterance with who said it. Defaults to true. */
  speakers?: boolean;
  /** Label each utterance with when it was said. Defaults to true. */
  timestamps?: boolean;
  combine?: CombineMode;
  /** A language the meeting has already been translated into. */
  language?: string | null;
}

/**
 * The reader's time zone, so a meeting that ran at 23:30 is dated in the file
 * the way it was dated on the screen they exported it from.
 */
function timeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function exportPath(
  meetingId: string,
  format: ExportFormat,
  options: ExportOptions = {},
  zone: string | null = timeZone(),
): string {
  const params = new URLSearchParams({ format });
  // Only what differs from the endpoint's defaults, so a plain summary export
  // still produces the short URL it always did — and so a bookmarked one keeps
  // meaning what it meant.
  if (options.summary === false) params.set("summary", "false");
  if (options.sections?.length) params.set("sections", options.sections.join(","));
  if (options.actionItems === false) params.set("actionItems", "false");
  if (options.transcript) params.set("transcript", "true");
  if (options.speakers === false) params.set("speakers", "false");
  if (options.timestamps === false) params.set("timestamps", "false");
  if (options.combine && options.combine !== "none") params.set("combine", options.combine);
  if (options.language) params.set("language", options.language);
  if (zone) params.set("tz", zone);
  return `/meetings/${meetingId}/export?${params.toString()}`;
}

/**
 * The name the server gave the file.
 *
 * <p>`filename*` first: it is the one that survives a title in Japanese or
 * Arabic, and the plain `filename` beside it is a deliberately lossy fallback
 * that would otherwise win by being listed first.
 */
export function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Malformed percent-encoding: fall through to the plain form rather than
      // failing a download over the name of the file.
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition);
  return plain?.[1] || fallback;
}

/* ------------------------------- failures -------------------------------- */

/**
 * A failure the server explained in words.
 *
 * <p>Distinguished from every other export failure by its type rather than by
 * inspecting the text, so a toast can show this one and refuse the rest.
 * `UsageLimitService` and the export controller write these sentences to be
 * read; a rejected fetch or a status code is not one of them.
 */
export class ExportError extends Error {}

/**
 * A failure with a status and nothing worth quoting.
 *
 * <p>Its message is for a log. {@link describeExportFailure} is what a person
 * sees, and it never contains this one — "Download failed (502)" tells somebody
 * their export did not happen and gives them no idea what to do about it.
 */
export class DownloadFailure extends Error {
  constructor(readonly status: number | string) {
    super(`Download failed (${status})`);
    this.name = "DownloadFailure";
  }
}

/** Gateways and proxies. A 500 is a bug: repeating it repeats the bug. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** RTK Query's non-HTTP statuses. The first two are worth another go. */
const TRANSPORT_STATUS = new Set(["FETCH_ERROR", "TIMEOUT_ERROR"]);

function statusOf(error: unknown): number | string | null {
  if (error instanceof DownloadFailure) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" || typeof status === "string" ? status : null;
}

/**
 * Whether trying the same request again could plausibly work.
 *
 * <p>Deliberately narrow. A network that dropped and a gateway that was
 * restarting are the cases where the second attempt is different from the
 * first; a 404, a 403 or a 400 will produce exactly the same answer, and
 * retrying them doubles the load at the moment the server is least able to
 * take it. A 500 is excluded for the same reason — it means the request
 * reached the application and broke it.
 *
 * <p>Only used for GETs. Every download in this module is one; nothing here
 * retries anything that writes.
 */
export function isTransientFailure(error: unknown): boolean {
  // A rejected fetch. The browser's own message is "Failed to fetch" or
  // "NetworkError when attempting to fetch resource" depending on the engine,
  // which is why this checks the type rather than the words.
  if (error instanceof TypeError) return true;
  const status = statusOf(error);
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);
  if (typeof status === "string") return TRANSPORT_STATUS.has(status);
  return false;
}

/**
 * The server's own sentence, when it wrote one meant for a person.
 *
 * <p>Only from a 4xx. Those are Orion refusing something and explaining why —
 * "this meeting has not been translated into German", "you have reached this
 * month's limit" — and repeating them is the whole value. A 5xx body is either
 * the generic "An unexpected error occurred" or, when a proxy answered instead
 * of the application, a page of HTML; neither is worth putting in front of
 * anybody, and the HTML case is how technical detail leaks into a UI.
 */
function serverSentence(error: unknown): string | null {
  if (error instanceof ExportError) return error.message;
  const status = statusOf(error);
  if (typeof status !== "number" || status < 400 || status >= 500) return null;
  const message = (error as { data?: { message?: unknown } })?.data?.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  // Length and shape as a last guard. A stack trace or a serialised exception
  // that reached a `message` field is not a sentence somebody wrote to be read.
  if (!trimmed || trimmed.length > 300 || /\n\s*at\s/.test(trimmed)) return null;
  return trimmed;
}

const PART_NOUN: Record<ExportPart, string> = {
  summary: "the summary",
  transcript: "the transcript",
  audio: "the audio",
};

/**
 * What to put on screen when one part of an export did not happen.
 *
 * <p>Names the part. "Couldn't export this meeting" after choosing three things
 * leaves somebody checking their downloads folder to work out which of them
 * arrived; "Couldn't export the transcript" is answerable.
 *
 * <p>Never carries a status code, a stack, a URL or the browser's own phrasing.
 * Those go to the console, where they help; "TypeError: Failed to fetch" in a
 * toast is true and useless.
 */
export function describeExportFailure(part: ExportPart, error: unknown): string {
  const sentence = serverSentence(error);
  if (sentence) return sentence;
  const base = `Couldn't export ${PART_NOUN[part]}.`;
  return isTransientFailure(error)
    ? `${base} Check your connection and try again.`
    : base;
}

/* ------------------------------- fetching -------------------------------- */

/** How long to wait before the single retry. */
export const RETRY_DELAY_MS = 600;

export interface ExportFile {
  blob: Blob;
  filename: string;
}

async function requestFile(path: string, fallbackName: string): Promise<ExportFile> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    headers: await buildAuthHeaders(),
  });
  if (!response.ok) {
    // The body is the API's JSON error, and its message is the useful part —
    // "this meeting has not been translated into German" beats "failed".
    let message = "";
    try {
      message = (await response.json())?.message ?? "";
    } catch {
      // Not JSON at all. A 502 from a proxy is an HTML page; a truncated
      // response is nothing. Both land here, and both must be a status-only
      // failure rather than a body quoted at the user.
      message = "";
    }
    // Two different failures, thrown as two different types so the caller does
    // not have to guess. `ExportError` carries a sentence the server wrote to
    // be read, and is never retried — the server has decided. `DownloadFailure`
    // carries a status, which is not something to put in front of anybody, and
    // may be worth one more attempt.
    if (message && response.status >= 400 && response.status < 500) {
      throw new ExportError(message);
    }
    throw new DownloadFailure(response.status);
  }
  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get("Content-Disposition"), fallbackName),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask for a rendered document, once more if the first attempt was unlucky.
 *
 * <p>One retry, not three. A second attempt covers the whole of what a retry is
 * for here — a connection that dropped mid-request, a gateway that was being
 * replaced — and each further attempt buys less while making a genuinely broken
 * export take longer to say so. The export is also a GET with no side effects,
 * which is what makes repeating it safe at all.
 */
export async function fetchExportFile(
  meetingId: string,
  format: ExportFormat,
  options: ExportOptions = {},
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<ExportFile> {
  const path = exportPath(meetingId, format, options);
  const fallback = `meeting.${format}`;
  try {
    return await requestFile(path, fallback);
  } catch (error) {
    if (!isTransientFailure(error)) throw error;
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    return requestFile(path, fallback);
  }
}

/*
 * There was a `downloadExport(meetingId, format, options)` here that fetched a
 * document and saved it immediately. It is gone, and deliberately not kept as a
 * convenience: fetching one part and putting it straight on the disk is now
 * precisely the thing a multi-part export must not do, and leaving a function
 * that does exactly that one import away is an invitation. Delivery decisions
 * belong to `lib/export-run.ts`, which is the only place that knows whether
 * this is the whole export or a third of it.
 */

/* ------------------------------- delivery -------------------------------- */

/**
 * How long the object URL is kept alive after the click.
 *
 * <p>The bug this replaces was revoking it in the same tick. A browser does not
 * read a blob URL during `click()`; it schedules the download and reads it
 * afterwards, so revoking immediately is a race against the download the user
 * asked for — one that a fast machine usually wins and a slow one, or a large
 * transcript, sometimes does not. Nothing throws when it loses.
 *
 * <p>A minute is far longer than any browser needs and costs one blob held in
 * memory until then. Orion's documents are measured in megabytes; the audio
 * never comes through here at all.
 */
export const REVOKE_DELAY_MS = 60_000;

/** Put a blob on the disk under a name. */
export function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  // Both on a timer, and the anchor could safely go sooner — it is the URL that
  // matters. Doing them together keeps it to one deferred action to reason
  // about, and a hidden anchor for a minute is invisible either way.
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

/**
 * Everything selected, as one archive.
 *
 * <p>The alternative — a synthetic click per file — is what browsers block, and
 * they block it silently. Written here rather than fetched from the server
 * because only the client knows what was selected, and because the recording
 * comes from object storage rather than from the API: there is no one place on
 * the server that has all three pieces.
 *
 * <p>Blobs go in and are never converted. The recording can be a hundred
 * megabytes, and turning it into a `Uint8Array` on the way past would put a
 * second copy of it in this tab's heap for no reason at all.
 */
export async function buildBundle(files: ExportFile[]): Promise<Blob> {
  return zip(files.map((file) => ({ name: file.filename, blob: file.blob })));
}

/**
 * What to call one file inside the archive.
 *
 * <p>The server names both documents after the meeting, so a summary and a
 * transcript exported in the same format both arrive as
 * {@code sprint-planning.txt}. Inside an archive that is a real problem: an
 * extractor is entitled to overwrite one with the other, and the user loses a
 * file they asked for without being told. So the part is spelled out.
 *
 * <p>Only inside the archive. A single file keeps the name the server gave it —
 * the qualifier exists to disambiguate, and there is nothing to disambiguate
 * when one file is all there is.
 */
export function entryName(part: ExportPart, filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return `${stem || "meeting"}-${part}${ext}`;
}

/**
 * What to call the archive.
 *
 * <p>After the meeting, because that is what somebody will be looking for in a
 * downloads folder six months later. The stem is taken from a filename the
 * server already produced, so it has already been through the same slugging as
 * the files inside it.
 */
export function bundleName(files: ExportFile[]): string {
  const first = files[0]?.filename ?? "meeting";
  const dot = first.lastIndexOf(".");
  const stem = dot > 0 ? first.slice(0, dot) : first;
  return `${stem || "meeting"}-export.zip`;
}

/**
 * Send the browser to a presigned link.
 *
 * <p>Kept for a caller that wants a navigation rather than bytes. Nothing in the
 * export dialog uses it any more: an atomic export has to know the recording
 * arrived before it offers the user anything, and a navigation cannot be
 * observed — the tab never learns whether it worked.
 *
 * <p>No `target`, on purpose. A link with `target="_blank"` opened after an
 * `await` is no longer inside a user gesture and gets caught by the popup
 * blocker; a same-tab navigation to a `Content-Disposition: attachment`
 * response downloads without navigating anywhere.
 */
export function openSignedDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noreferrer noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 0);
}

/**
 * Pull a presigned object out of storage as bytes.
 *
 * <h2>Why the recording now comes through the tab</h2>
 *
 * <p>It used to be a navigation to the signed URL, which is cheaper: the file
 * goes straight from object storage to the disk and never touches this process.
 * That is incompatible with an atomic export. To put the MP3 in the same archive
 * as the documents — and to know it arrived <em>before</em> anything is offered
 * to the user — the bytes have to be here.
 *
 * <p>It is still not proxied through Spring, which is the part that mattered.
 * The request goes browser → R2 carrying a short-lived signature, and the API
 * neither sees the transfer nor pays for it. What lands here is a {@link Blob},
 * which browsers back with disk rather than script memory once it is large, and
 * which the archive references rather than copies.
 *
 * <p><b>No headers at all</b>, deliberately. The credential is in the URL;
 * adding `Authorization` would both fall outside the signature and turn a
 * simple cross-origin GET into a preflighted one. This does require the bucket
 * to allow GET from the app's origin — see docs/deploy.md.
 */
export async function fetchSignedFile(
  url: string,
  filename: string,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<ExportFile> {
  const once = async (): Promise<ExportFile> => {
    const response = await fetch(url);
    if (!response.ok) {
      // Never the body. Object storage answers with an XML error document
      // naming the bucket, the key and a request id, and none of that is for a
      // person to read.
      throw new DownloadFailure(response.status);
    }
    return { blob: await response.blob(), filename };
  };
  try {
    return await once();
  } catch (error) {
    if (!isTransientFailure(error)) throw error;
    if (retryDelayMs > 0) await sleep(retryDelayMs);
    return once();
  }
}
