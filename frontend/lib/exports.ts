/**
 * Downloading a meeting, or the whole account.
 *
 * <p>The file is built by the server — see the export renderers — so this module
 * only has to ask for it and get it onto the disk. That is less trivial than it
 * sounds, for one reason: the request needs the session's auth header, and a
 * plain `<a href>` cannot carry one. So the bytes are fetched, turned into a
 * blob and handed to a synthetic link, which is also what lets the filename come
 * from `Content-Disposition` rather than from a guess made here.
 *
 * <p>Everything except the two `download…` functions is pure, so the awkward
 * parts — the query string and the header parsing — are testable without a
 * browser.
 */

import { API_BASE } from "@/lib/api";
import { buildAuthHeaders } from "@/lib/auth-store";

export type ExportFormat = "pdf" | "docx" | "md" | "txt";

export interface ExportOptions {
  /** The transcript is left out unless asked for; it is most of the file. */
  transcript?: boolean;
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
  if (options.transcript) params.set("transcript", "true");
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

/** Put a blob on the disk under a name. */
export function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Fetch an authenticated file and put it on the disk.
 *
 * <p>Shared by the two downloads that go through the API rather than through a
 * signed storage URL, so they cannot come to disagree about how a failure reads
 * or where the filename comes from.
 */
async function fetchAndSave(path: string, fallbackName: string): Promise<void> {
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
      message = "";
    }
    throw new Error(message || `Download failed (${response.status})`);
  }
  save(
    await response.blob(),
    filenameFrom(response.headers.get("Content-Disposition"), fallbackName),
  );
}

export async function downloadExport(
  meetingId: string,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<void> {
  return fetchAndSave(exportPath(meetingId, format, options), `meeting.${format}`);
}

/**
 * The whole account, as a zip.
 *
 * <p>The same mechanism as a single meeting and a different promise: this is the
 * thing somebody downloads before pressing the button underneath it, so it goes
 * through the same authenticated fetch rather than a link that could be shared
 * by accident.
 */
export async function downloadAccountArchive(
  zone: string | null = timeZone(),
): Promise<void> {
  const params = new URLSearchParams();
  if (zone) params.set("tz", zone);
  const query = params.toString();
  return fetchAndSave(`/privacy/export${query ? `?${query}` : ""}`, "recallix-export.zip");
}

/**
 * Send the browser to a presigned link.
 *
 * <p>Not fetched and re-saved like the documents above: the recording is tens or
 * hundreds of megabytes, and pulling it into memory to hand it straight back
 * would be slower and could exhaust a tab. The link already carries the
 * disposition that names the file, signed into the URL.
 */
export function openSignedDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noreferrer noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
