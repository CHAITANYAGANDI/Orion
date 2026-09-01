/**
 * Waiting for an MP3 that has to be made first.
 *
 * <h2>Why there is a wait at all</h2>
 *
 * <p>Reverie stores what was uploaded: webm from a browser, m4a from a phone, wav
 * from a desk recorder. "Export as MP3" therefore means encoding one, and
 * encoding an hour of audio takes tens of seconds. A request that waited for it
 * would be cut off by a proxy long before it finished — after doing all of the
 * work, which is the worst way to fail.
 *
 * <p>So the endpoint answers immediately with `ready`, `preparing` or `failed`,
 * and this asks again until it settles. The first export of a meeting waits; the
 * second is instant, because the converted copy is kept in object storage under
 * a key derived from the recording's own. Nothing here knows that — it is worth
 * knowing only because it is why the wait happens once per meeting and not once
 * per export.
 *
 * <h2>Why the polling is a plain function</h2>
 *
 * <p>Not `pollingInterval` on the query. That polls forever, keeps polling while
 * the tab is in the background, and gives the component the job of noticing that
 * a value it already has means "stop" — which is a state machine spread across
 * a hook, a `useEffect` and a ref. A loop that ends when the answer arrives is
 * the same behaviour written where it can be read, and where it can be tested
 * without a clock.
 */

import { ExportError } from "@/lib/exports";

export interface Mp3Export {
  status: string;
  url?: string | null;
  filename?: string | null;
  contentType?: string | null;
  expiresInSeconds?: number | null;
  message?: string | null;
}

/** A settled, usable answer: a link that exists and has not gone stale. */
export interface Mp3Link {
  url: string;
  filename: string;
  contentType: string;
  /** When the link stops working, as a timestamp rather than a duration. */
  expiresAt: number;
}

export const POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep asking.
 *
 * <p>Five minutes covers every recording Reverie realistically holds — LAME runs
 * at tens of times real time, so even a three-hour meeting is a couple of
 * minutes. Past that, giving up is the honest thing: nobody watches a dialog for
 * ten minutes, and the conversion does not stop when this does. The next attempt
 * finds it finished.
 */
export const POLL_LIMIT = 150;

/**
 * Treat a link as dead slightly before it is.
 *
 * <p>A signature with two seconds left is worse than no signature: the click
 * succeeds, the download starts, and object storage rejects it halfway with a
 * message about an expired token that the user will read as their file being
 * gone. A little early is a fresh link; a little late is a broken download.
 */
export const EXPIRY_MARGIN_MS = 30_000;

export interface PollIo {
  wait: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  limit?: number;
}

const defaultIo: PollIo = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Ask until the MP3 is ready, or until there is a reason to stop.
 *
 * @param ask one request to the prepare endpoint; called repeatedly
 * @throws ExportError with a sentence meant for a person — the conversion's own
 *         explanation when it failed, and a description of what to do next when
 *         it simply took too long
 */
export async function prepareMp3(
  ask: () => Promise<Mp3Export>,
  io: PollIo = defaultIo,
): Promise<Mp3Link> {
  const interval = io.intervalMs ?? POLL_INTERVAL_MS;
  const limit = io.limit ?? POLL_LIMIT;

  for (let attempt = 0; attempt < limit; attempt++) {
    const answer = await ask();

    if (answer.status === "failed") {
      throw new ExportError(
        answer.message || "The audio could not be converted. Try again in a moment.",
      );
    }
    if (answer.status === "ready") {
      const link = toLink(answer, io.now());
      if (link) return link;
      // Ready without a URL should not happen; the endpoint sends one or says
      // it is not finished. Treating it as an error rather than looping is the
      // difference between a message and a dialog that spins forever.
      throw new ExportError("The audio could not be converted. Try again in a moment.");
    }
    // `preparing`, or a status this build does not know. Both mean "ask again":
    // a client that treated an unfamiliar status as failure would break the
    // moment the server learned a new one.
    await io.wait(interval);
  }

  // Deliberately not phrased as a failure, because it is not one. The
  // conversion carries on without this dialog and the next attempt will find it
  // done -- which is the useful thing to tell somebody.
  throw new ExportError(
    "Preparing the MP3 is taking longer than usual. It is still converting — " +
      "try the export again in a few minutes.",
  );
}

function toLink(answer: Mp3Export, now: number): Mp3Link | null {
  if (!answer.url) return null;
  const seconds = answer.expiresInSeconds ?? 0;
  return {
    url: answer.url,
    filename: answer.filename || "meeting.mp3",
    contentType: answer.contentType || "audio/mpeg",
    expiresAt: now + Math.max(0, seconds) * 1000,
  };
}

/**
 * Whether a link held from an earlier answer is still worth following.
 *
 * <p>The dialog keeps the last one so the recording can be downloaded again
 * without waiting. That link is short-lived by design, and the case it exists
 * for — somebody who left the dialog open, or came back to retry — is exactly
 * the case where it has expired. So it is checked rather than trusted, and a
 * stale one is replaced by asking again, which now costs a signature rather
 * than a conversion.
 */
export function linkIsFresh(link: Mp3Link | null, now: number): link is Mp3Link {
  return link !== null && link.expiresAt - EXPIRY_MARGIN_MS > now;
}
