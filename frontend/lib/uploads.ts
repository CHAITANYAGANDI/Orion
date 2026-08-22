/**
 * The three things every import does, wherever it is started from.
 *
 * A file can be added from the Import dialog in the header or from the upload
 * page, and both do the same three steps: ask the browser how long the media
 * is, PUT it straight to storage, and turn a failure into a sentence. Kept here
 * so the two cannot drift — the version that matters most is the last one,
 * because an upload that fails silently is indistinguishable from one that
 * worked until the meeting never appears.
 */

/**
 * Whether the server would accept this file at all.
 *
 * <p>Mirrors `MeetingService.ALLOWED_PREFIXES` rather than a list of
 * extensions. The backend takes any `audio/*` or `video/*`, so an allowlist of
 * eight formats here would reject files the pipeline handles perfectly well.
 *
 * <p>PDFs were accepted once, as a meeting whose text skipped transcription.
 * They are not any more: nobody attended a document, and every feature that
 * followed — speakers, timestamps, playback — had to pretend otherwise.
 */
export function isImportable(file: File): boolean {
  return /^(audio|video)\//.test(file.type);
}

/**
 * The formats worth naming in the UI.
 *
 * <p>Named as examples, not as a contract — the check above is what actually
 * decides. Listing these is still worth it, because "any audio or video file"
 * does not answer the question somebody with a `.m4a` is actually asking.
 */
export const COMMON_FORMATS = "MP3, M4A, WAV, AAC, WMA, MP4, MOV, MPEG, WMV";

/**
 * How long the media runs, or null.
 *
 * <p>Read in the browser because the server would have to download the whole
 * object to find out, and the number is wanted immediately — it is what turns
 * "84.2 MB" into something a person can picture. Null is a normal answer: a PDF
 * has no timeline and a container the browser cannot parse has no duration it
 * is willing to state.
 */
export function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith("video/");
    const el = document.createElement(isVideo ? "video" : "audio");
    el.preload = "metadata";
    const url = URL.createObjectURL(file);
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? Math.round(el.duration) : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    el.src = url;
  });
}

/**
 * PUT the file straight to storage.
 *
 * <p>XHR rather than fetch, and the reason is the progress bar: fetch has no
 * upload progress event, and an hour of video on a domestic connection is
 * several minutes of a UI that has to be able to say it is still working.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      // `e.total` is zero for an empty body, and `0 / 0` is NaN — which reaches
      // the progress bar as "NaN%" and sticks there, because every later frame
      // computes the same thing.
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — network or CORS error"));
    // Both of these settle a promise that would otherwise be waited on forever.
    // A caller that sets a phase before awaiting this has no way back from a
    // promise that never resolves, and the bar it belongs to has no way out.
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.send(file);
  });
}

/**
 * The API's own message, when it sent one.
 *
 * <p>It is nearly always the useful part — "You have used all 3 imports on
 * this account" beats "Something went wrong", and the allowance refusal is the
 * one somebody is most likely to hit here. The server writes those sentences
 * (UsageLimitService) precisely so this can pass them straight through.
 */
export function uploadError(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
