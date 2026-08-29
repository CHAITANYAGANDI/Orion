import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }));
vi.mock("@/lib/auth-store", () => ({ buildAuthHeaders: async () => ({}) }));

import { runExport, STAGGER_MS, type ExportIo, type ExportPlan } from "@/lib/export-run";
import { DownloadFailure, ExportError, type ExportFile } from "@/lib/exports";

/**
 * One export, several parts, and what happens when one of them does not work.
 *
 * <p>The bug: the dialog awaited the summary, then the transcript, then the
 * audio, inside a single `try`. A summary that failed took the other two with
 * it — neither attempted, neither mentioned — and the user was told "Couldn't
 * export this meeting", which does not say which part, or that two of the three
 * were never tried at all.
 *
 * <p>Everything below is one of two claims. Nothing that failed is reported as
 * having worked, and nothing that worked is thrown away because something else
 * did not.
 */

function file(name: string, body = "content"): ExportFile {
  return { blob: new Blob([body]), filename: name };
}

function io(over: Partial<ExportIo> = {}) {
  const saved: { name: string; blob: Blob }[] = [];
  const pauses: number[] = [];
  const base: ExportIo = {
    save: (blob, name) => saved.push({ name, blob }),
    bundle: async (files) => new Blob([`zip:${files.map((f) => f.filename).join("|")}`]),
    bundleName: () => "sprint-planning.zip",
    pause: async (ms) => void pauses.push(ms),
    ...over,
  };
  return { io: base, saved, pauses };
}

const summary = (fetch: () => Promise<ExportFile>) => ({ part: "summary" as const, fetch });
const transcript = (fetch: () => Promise<ExportFile>) => ({ part: "transcript" as const, fetch });

describe("runExport", () => {
  it("saves a single document as itself", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport(
      { documents: [summary(async () => file("sprint-planning.txt"))] },
      deps,
    );

    // One file is one download; wrapping it in an archive would make somebody
    // unzip a single text file for no reason.
    expect(saved.map((s) => s.name)).toEqual(["sprint-planning.txt"]);
    expect(outcome).toMatchObject({ delivered: ["summary"], complete: true });
  });

  it("bundles two documents into one download", async () => {
    // The reliability fix. Two synthetic clicks in a row is what browsers block
    // -- Chrome prompts once per origin and drops the rest silently if the
    // prompt is denied -- so both requested files must arrive as one.
    const { io: deps, saved } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => file("sprint-planning.txt")),
          transcript(async () => file("sprint-planning-transcript.md")),
        ],
      },
      deps,
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("sprint-planning.zip");
    expect(outcome.delivered).toEqual(["summary", "transcript"]);
  });

  it("reliably produces every document that was asked for", async () => {
    const { io: deps, saved } = io();

    await runExport(
      {
        documents: [
          summary(async () => file("a.txt", "summary")),
          transcript(async () => file("b.md", "transcript")),
        ],
      },
      deps,
    );

    // Named inside the archive, which is what somebody sees when they open it.
    expect(new TextDecoder().decode(await saved[0].blob.arrayBuffer())).toBe("zip:a.txt|b.md");
  });

  it("still delivers the transcript when the summary fails", async () => {
    // THE bug. Under the old code the transcript was never requested.
    const { io: deps, saved } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => {
            throw new DownloadFailure(500);
          }),
          transcript(async () => file("sprint-planning-transcript.md")),
        ],
      },
      deps,
    );

    expect(saved.map((s) => s.name)).toEqual(["sprint-planning-transcript.md"]);
    expect(outcome.delivered).toEqual(["transcript"]);
    expect(outcome.failures.map((f) => f.part)).toEqual(["summary"]);
  });

  it("never calls a partial export complete", async () => {
    // The other half of the same rule: a download that did not happen must not
    // be reported as one that did, at any level.
    const { io: deps } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => file("a.txt")),
          transcript(async () => {
            throw new DownloadFailure(500);
          }),
        ],
      },
      deps,
    );

    expect(outcome.complete).toBe(false);
    expect(outcome.delivered).toEqual(["summary"]);
    expect(outcome.failures).toHaveLength(1);
  });

  it("attempts every part even when all of them fail", async () => {
    const attempts: string[] = [];
    const { io: deps, saved } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => {
            attempts.push("summary");
            throw new DownloadFailure(500);
          }),
          transcript(async () => {
            attempts.push("transcript");
            throw new TypeError("Failed to fetch");
          }),
        ],
        audio: async () => {
          attempts.push("audio");
          throw new DownloadFailure(503);
        },
      },
      deps,
    );

    expect(attempts).toEqual(["summary", "transcript", "audio"]);
    expect(saved).toHaveLength(0);
    expect(outcome.failures.map((f) => f.part)).toEqual(["summary", "transcript", "audio"]);
  });

  it("names each failed part in words a person can act on", async () => {
    const { io: deps } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => {
            throw new DownloadFailure(500);
          }),
          transcript(async () => {
            throw new TypeError("Failed to fetch");
          }),
        ],
        audio: async () => {
          throw new DownloadFailure(502);
        },
      },
      deps,
    );

    expect(outcome.failures[0].message).toContain("Couldn't export the summary");
    expect(outcome.failures[1].message).toContain("Couldn't export the transcript");
    expect(outcome.failures[2].message).toContain("Couldn't export the audio");
    for (const failure of outcome.failures) {
      // Nothing technical. Not a status, not "Failed to fetch", not a URL.
      expect(failure.message).not.toMatch(/\d{3}\b|fetch|blob:|http/i);
    }
  });

  it("prefers what the server said when the server said something useful", async () => {
    const { io: deps } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => {
            throw new ExportError("You have reached this month's export limit.");
          }),
        ],
      },
      deps,
    );

    expect(outcome.failures[0].message).toBe("You have reached this month's export limit.");
  });

  it("exports the audio even when both documents failed", async () => {
    // The recording is fetched from object storage and has nothing to do with
    // the document renderer; a failure there says nothing about this.
    let delivered = false;
    const { io: deps } = io();

    const outcome = await runExport(
      {
        documents: [
          summary(async () => {
            throw new DownloadFailure(500);
          }),
        ],
        audio: async () => {
          delivered = true;
        },
      },
      deps,
    );

    expect(delivered).toBe(true);
    expect(outcome.delivered).toEqual(["audio"]);
  });

  it("keeps the documents when the recording fails", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport(
      {
        documents: [summary(async () => file("a.txt"))],
        audio: async () => {
          throw new DownloadFailure(404);
        },
      },
      deps,
    );

    expect(saved).toHaveLength(1);
    expect(outcome.delivered).toEqual(["summary"]);
    expect(outcome.failures.map((f) => f.part)).toEqual(["audio"]);
  });

  it("spaces the recording out from the document download", async () => {
    // Two downloads is the floor when documents and audio are both wanted: the
    // recording cannot go in the archive without pulling hundreds of megabytes
    // through the tab. Spacing them is what keeps the second from looking like
    // the automatic-multiple-download pattern browsers throttle.
    const { io: deps, pauses } = io();

    await runExport(
      { documents: [summary(async () => file("a.txt"))], audio: async () => {} },
      deps,
    );

    expect(pauses).toEqual([STAGGER_MS]);
  });

  it("does not pause before an audio-only export", async () => {
    const { io: deps, pauses } = io();

    await runExport({ documents: [], audio: async () => {} }, deps);

    expect(pauses).toEqual([]);
  });

  it("falls back to separate downloads rather than losing a built archive", async () => {
    // Every document is in hand at this point. Giving them up over the
    // packaging would be the worst outcome available -- so the fallback is the
    // old behaviour, which the browser may still refuse, which is exactly why
    // it is the fallback and not the plan.
    const { io: deps, saved, pauses } = io({
      bundle: async () => {
        throw new Error("no ArrayBuffer here");
      },
    });

    const outcome = await runExport(
      {
        documents: [
          summary(async () => file("a.txt")),
          transcript(async () => file("b.md")),
        ],
      },
      deps,
    );

    expect(saved.map((s) => s.name)).toEqual(["a.txt", "b.md"]);
    expect(pauses).toEqual([STAGGER_MS]);
    expect(outcome.complete).toBe(true);
  });

  it("does nothing at all when nothing was chosen", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport({ documents: [] }, deps);

    expect(saved).toHaveLength(0);
    expect(outcome).toEqual({ delivered: [], failures: [], complete: true });
  });

  it("requests the documents one at a time", async () => {
    // Rendering a forty-page transcript is not cheap, and two renders of the
    // same meeting at once double the load for no gain anybody can perceive.
    const inFlight: number[] = [];
    let active = 0;
    const slow = async () => {
      active++;
      inFlight.push(active);
      await Promise.resolve();
      active--;
      return file("x.txt");
    };
    const { io: deps } = io();

    await runExport({ documents: [summary(slow), transcript(slow)] }, deps);

    expect(Math.max(...inFlight)).toBe(1);
  });
});
