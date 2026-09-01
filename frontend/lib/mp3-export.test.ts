import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }));
vi.mock("@/lib/auth-store", () => ({ buildAuthHeaders: async () => ({}) }));

import {
  EXPIRY_MARGIN_MS,
  linkIsFresh,
  prepareMp3,
  type Mp3Export,
  type Mp3Link,
} from "@/lib/mp3-export";
import { ExportError } from "@/lib/exports";

/**
 * Waiting for an MP3 that has to be made first.
 *
 * <p>Reverie stores what was uploaded — webm from a browser, m4a from a phone —
 * so "export as MP3" means encoding one, and encoding an hour of audio takes
 * tens of seconds. The endpoint therefore answers `preparing` and the client
 * asks again, which introduces exactly two things that can go wrong: a wait that
 * never ends, and a wait that ends by claiming success it does not have.
 */

const ready: Mp3Export = {
  status: "ready",
  url: "https://r2/signed.mp3",
  filename: "sprint-planning.mp3",
  contentType: "audio/mpeg",
  expiresInSeconds: 900,
};

const preparing: Mp3Export = { status: "preparing", url: null, expiresInSeconds: 0 };

function poller(answers: Mp3Export[]) {
  const waits: number[] = [];
  const ask = vi.fn(async () => answers.shift() ?? preparing);
  return {
    ask,
    waits,
    io: {
      wait: async (ms: number) => void waits.push(ms),
      now: () => 1_000_000,
      intervalMs: 10,
      limit: 5,
    },
  };
}

describe("prepareMp3", () => {
  it("returns the link when the conversion is already done", async () => {
    // The second export of any meeting, and the first for a recording that was
    // an MP3 to begin with: no wait at all.
    const { ask, io, waits } = poller([ready]);

    const link = await prepareMp3(ask, io);

    expect(link.url).toBe("https://r2/signed.mp3");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("names the file .mp3 and calls it audio/mpeg", async () => {
    // Both, because both are how a browser and an operating system decide what
    // the file is, and a rename dressed up as a conversion gets one right.
    const link = await prepareMp3(...args([ready]));

    expect(link.filename.endsWith(".mp3")).toBe(true);
    expect(link.contentType).toBe("audio/mpeg");
  });

  it("keeps asking while it is preparing", async () => {
    const { ask, io } = poller([preparing, preparing, ready]);

    const link = await prepareMp3(ask, io);

    expect(ask).toHaveBeenCalledTimes(3);
    expect(link.url).toBe("https://r2/signed.mp3");
  });

  it("waits between attempts rather than spinning", async () => {
    const { ask, io, waits } = poller([preparing, ready]);

    await prepareMp3(ask, io);

    expect(waits).toEqual([10]);
  });

  it("repeats the reason a conversion failed", async () => {
    // The service knows things a status code cannot say -- "this recording has
    // no audio to convert" sends somebody to the right conclusion immediately.
    const { ask, io } = poller([
      preparing,
      { status: "failed", url: null, expiresInSeconds: 0, message: "This recording has no audio to convert." },
    ]);

    await expect(prepareMp3(ask, io)).rejects.toThrow("This recording has no audio to convert.");
  });

  it("has something to say when the failure came with no words", async () => {
    const { ask, io } = poller([{ status: "failed", url: null, expiresInSeconds: 0 }]);

    await expect(prepareMp3(ask, io)).rejects.toBeInstanceOf(ExportError);
  });

  it("stops asking after a failure", async () => {
    const { ask, io } = poller([{ status: "failed", url: null, expiresInSeconds: 0 }]);

    await expect(prepareMp3(ask, io)).rejects.toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("gives up eventually rather than spinning forever", async () => {
    const { ask, io } = poller([]);

    await expect(prepareMp3(ask, io)).rejects.toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it("says the conversion is still going when it gives up", async () => {
    // It is not a failure and must not read as one: the encode continues after
    // this dialog stops watching, and the next attempt finds it finished.
    const { ask, io } = poller([]);

    await expect(prepareMp3(ask, io)).rejects.toThrow(/still converting/i);
  });

  it("lets the request's own failure through", async () => {
    // A 400 for a document-only meeting, a 404 for an erased recording. Both
    // carry a sentence from the server and neither is something to swallow.
    const ask = vi.fn(async () => {
      throw { status: 400, data: { message: "This meeting was imported from a document." } };
    });

    await expect(prepareMp3(ask, poller([]).io)).rejects.toMatchObject({ status: 400 });
  });

  it("treats a status it does not recognise as 'ask again'", async () => {
    // A client that read an unfamiliar status as failure would break the first
    // time the server learned a new one.
    const { ask, io } = poller([{ status: "queued", url: null, expiresInSeconds: 0 }, ready]);

    await expect(prepareMp3(ask, io)).resolves.toBeTruthy();
  });

  it("does not spin when told 'ready' with no link", async () => {
    // Should not happen; the endpoint sends a URL or says it is not finished.
    // Looping would be a dialog that never stops, which is worse than a message.
    const { ask, io } = poller([{ status: "ready", url: null, expiresInSeconds: 900 }]);

    await expect(prepareMp3(ask, io)).rejects.toBeInstanceOf(ExportError);
  });

  it("turns the lifetime into a moment it expires", async () => {
    const link = await prepareMp3(...args([ready]));

    // A duration is only meaningful at the instant it was received; a deadline
    // still means something to the code that checks it two minutes later.
    expect(link.expiresAt).toBe(1_000_000 + 900_000);
  });
});

function args(answers: Mp3Export[]): [() => Promise<Mp3Export>, ReturnType<typeof poller>["io"]] {
  const p = poller(answers);
  return [p.ask, p.io];
}

describe("linkIsFresh", () => {
  const link = (expiresAt: number): Mp3Link => ({
    url: "https://r2/signed.mp3",
    filename: "sprint-planning.mp3",
    contentType: "audio/mpeg",
    expiresAt,
  });

  it("is true for a link with plenty of time left", () => {
    expect(linkIsFresh(link(1_000_000 + 900_000), 1_000_000)).toBe(true);
  });

  it("is false once it has expired", () => {
    expect(linkIsFresh(link(999_000), 1_000_000)).toBe(false);
  });

  it("is false for a link that is about to expire", () => {
    // A signature with seconds left is worse than none: the click works, the
    // download starts, and object storage rejects it partway with a message
    // about an expired token that reads as the file being gone.
    expect(linkIsFresh(link(1_000_000 + EXPIRY_MARGIN_MS - 1), 1_000_000)).toBe(false);
  });

  it("is false when there is no link at all", () => {
    expect(linkIsFresh(null, 1_000_000)).toBe(false);
  });
});
