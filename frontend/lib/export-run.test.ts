import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }));
vi.mock("@/lib/auth-store", () => ({ buildAuthHeaders: async () => ({}) }));

import { runExport, type ExportIo } from "@/lib/export-run";
import { DownloadFailure, ExportError, type ExportFile } from "@/lib/exports";

/**
 * One export, several parts, and nothing delivered unless all of them arrive.
 *
 * <h2>Two bugs, in order</h2>
 *
 * <p>The first: the dialog awaited the summary, then the transcript, then the
 * audio inside one `try`, so a failed summary silently cancelled the other two.
 * Fixed by running each part independently.
 *
 * <p>The second, which that fix introduced: parts could then be delivered
 * independently, so somebody who ticked three things could receive two and a
 * message saying "2 of 3 downloaded". Partial delivery is the worse failure,
 * because it is quiet — a user who receives nothing tries again, and a user who
 * receives an archive missing the recording finds out weeks later.
 *
 * <p>So every test below is one of two claims. <b>Nothing is delivered unless
 * everything is</b>, and <b>a failure names the part that caused it</b>.
 */

function file(name: string, body = "content"): ExportFile {
  return { blob: new Blob([body]), filename: name };
}

function io(over: Partial<ExportIo> = {}) {
  const saved: { name: string; blob: Blob }[] = [];
  const bundled: string[][] = [];
  const base: ExportIo = {
    save: (blob, name) => saved.push({ name, blob }),
    bundle: async (files) => {
      bundled.push(files.map((f) => f.filename));
      return new Blob([`zip:${files.map((f) => f.filename).join("|")}`]);
    },
    bundleName: () => "sprint-planning-export.zip",
    ...over,
  };
  return { io: base, saved, bundled };
}

const summary = (fetch: () => Promise<ExportFile>) => ({ part: "summary" as const, fetch });
const transcript = (fetch: () => Promise<ExportFile>) => ({ part: "transcript" as const, fetch });
const audio = (fetch: () => Promise<ExportFile>) => ({ part: "audio" as const, fetch });

const ok = (name: string, body?: string) => () => Promise.resolve(file(name, body));
const fails = (error: unknown) => () => Promise.reject(error);

describe("runExport: one item", () => {
  it("saves a summary as itself", async () => {
    const { io: deps, saved, bundled } = io();

    const outcome = await runExport({ items: [summary(ok("sprint-planning.txt"))] }, deps);

    // One file is one download. Wrapping it in an archive would make somebody
    // unzip a single text file for no reason.
    expect(saved.map((s) => s.name)).toEqual(["sprint-planning.txt"]);
    expect(bundled).toEqual([]);
    expect(outcome).toMatchObject({ delivered: ["summary"], complete: true });
  });

  it("saves a transcript as itself", async () => {
    const { io: deps, saved, bundled } = io();

    await runExport({ items: [transcript(ok("sprint-planning.md"))] }, deps);

    expect(saved.map((s) => s.name)).toEqual(["sprint-planning.md"]);
    expect(bundled).toEqual([]);
  });

  it("saves audio on its own as a plain .mp3", async () => {
    const { io: deps, saved, bundled } = io();

    const outcome = await runExport({ items: [audio(ok("sprint-planning.mp3"))] }, deps);

    expect(saved.map((s) => s.name)).toEqual(["sprint-planning.mp3"]);
    expect(bundled).toEqual([]);
    expect(outcome.delivered).toEqual(["audio"]);
  });

  it("keeps the name the server chose for a single file", async () => {
    // The per-part suffix exists to stop two entries colliding inside an
    // archive. On its own there is nothing to disambiguate, and renaming it
    // would be churn a user has to notice.
    const { io: deps, saved } = io();

    await runExport({ items: [summary(ok("四半期.pdf"))] }, deps);

    expect(saved[0].name).toBe("四半期.pdf");
  });
});

describe("runExport: two or more items", () => {
  it("bundles a summary and a transcript into one archive", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport(
      { items: [summary(ok("sprint-planning.pdf")), transcript(ok("sprint-planning.txt"))] },
      deps,
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("sprint-planning-export.zip");
    expect(outcome.delivered).toEqual(["summary", "transcript"]);
  });

  it("bundles a summary and the recording into one archive", async () => {
    // The change: the MP3 goes inside, rather than arriving as a second
    // download that may never happen.
    const { io: deps, saved, bundled } = io();

    await runExport(
      { items: [summary(ok("sprint-planning.pdf")), audio(ok("sprint-planning.mp3"))] },
      deps,
    );

    expect(saved).toHaveLength(1);
    expect(bundled).toEqual([["sprint-planning-summary.pdf", "sprint-planning-audio.mp3"]]);
  });

  it("bundles all three into one archive", async () => {
    const { io: deps, saved, bundled } = io();

    await runExport(
      {
        items: [
          summary(ok("sprint-planning.pdf")),
          transcript(ok("sprint-planning.txt")),
          audio(ok("sprint-planning.mp3")),
        ],
      },
      deps,
    );

    expect(saved).toHaveLength(1);
    expect(bundled[0]).toEqual([
      "sprint-planning-summary.pdf",
      "sprint-planning-transcript.txt",
      "sprint-planning-audio.mp3",
    ]);
  });

  it("names the entries by part, so two .txt files cannot collide", async () => {
    // Both documents default to .txt and the server names both after the
    // meeting. Two entries called sprint-planning.txt is a zip an extractor may
    // resolve by overwriting one with the other.
    const { io: deps, bundled } = io();

    await runExport(
      { items: [summary(ok("sprint-planning.txt")), transcript(ok("sprint-planning.txt"))] },
      deps,
    );

    expect(new Set(bundled[0]).size).toBe(2);
    expect(bundled[0]).toEqual([
      "sprint-planning-summary.txt",
      "sprint-planning-transcript.txt",
    ]);
  });

  it("keeps the mp3 extension on the entry inside the archive", async () => {
    const { io: deps, bundled } = io();

    await runExport(
      { items: [summary(ok("m.pdf")), audio(ok("m.mp3"))] },
      deps,
    );

    expect(bundled[0][1].endsWith(".mp3")).toBe(true);
  });
});

describe("runExport: nothing is delivered unless everything is", () => {
  it("downloads nothing when the summary fails", async () => {
    const { io: deps, saved, bundled } = io();

    const outcome = await runExport(
      {
        items: [
          summary(fails(new DownloadFailure(500))),
          transcript(ok("sprint-planning.txt")),
        ],
      },
      deps,
    );

    // The transcript arrived. It is still not delivered: the user asked for a
    // set, and half a set handed over without comment is the quiet failure.
    expect(saved).toEqual([]);
    expect(bundled).toEqual([]);
    expect(outcome).toMatchObject({ delivered: [], complete: false });
  });

  it("downloads nothing when the transcript fails", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport(
      {
        items: [summary(ok("s.pdf")), transcript(fails(new DownloadFailure(503)))],
      },
      deps,
    );

    expect(saved).toEqual([]);
    expect(outcome.failures.map((f) => f.part)).toEqual(["transcript"]);
  });

  it("downloads nothing when the audio fails", async () => {
    // The one that used to slip through: documents were bundled and saved
    // before the recording was even attempted.
    const { io: deps, saved, bundled } = io();

    const outcome = await runExport(
      {
        items: [
          summary(ok("s.pdf")),
          transcript(ok("t.txt")),
          audio(fails(new ExportError("This recording has no audio to convert."))),
        ],
      },
      deps,
    );

    expect(saved).toEqual([]);
    expect(bundled).toEqual([]);
    expect(outcome.complete).toBe(false);
    expect(outcome.delivered).toEqual([]);
  });

  it("stops at the first failure instead of converting a recording for nothing", async () => {
    // Nothing after a failure can be delivered, so nothing after it is fetched.
    // The part that matters is the audio: it is last, it can take minutes, and
    // continuing would leave somebody watching "Preparing MP3…" for five
    // minutes before being told the summary failed.
    const attempts: string[] = [];
    const track = (name: string, then: () => Promise<ExportFile>) => () => {
      attempts.push(name);
      return then();
    };
    const { io: deps } = io();

    const outcome = await runExport(
      {
        items: [
          summary(track("summary", fails(new DownloadFailure(500)))),
          transcript(track("transcript", ok("t.txt"))),
          audio(track("audio", ok("a.mp3"))),
        ],
      },
      deps,
    );

    expect(attempts).toEqual(["summary"]);
    expect(outcome.failures.map((f) => f.part)).toEqual(["summary"]);
  });

  it("attributes the failure to the part that caused it, not the first one", async () => {
    // What the original single-`try` version could not do: it reported
    // "Couldn't export this meeting" whichever part had actually failed.
    const { io: deps } = io();

    const outcome = await runExport(
      {
        items: [summary(ok("s.pdf")), transcript(fails(new DownloadFailure(500)))],
      },
      deps,
    );

    expect(outcome.failures.map((f) => f.part)).toEqual(["transcript"]);
  });

  it("names each part in words a person can act on", async () => {
    const { io: deps } = io();
    const cases = [
      [summary(fails(new DownloadFailure(500))), "Couldn't export the summary"],
      [transcript(fails(new TypeError("Failed to fetch"))), "Couldn't export the transcript"],
      [audio(fails(new DownloadFailure(502))), "Couldn't export the audio"],
    ] as const;

    for (const [item, expected] of cases) {
      const outcome = await runExport({ items: [item] }, deps);

      expect(outcome.failures[0].message).toContain(expected);
      // Nothing technical. Not a status, not "Failed to fetch", not a URL.
      expect(outcome.failures[0].message).not.toMatch(/\d{3}\b|fetch|blob:|http/i);
    }
  });

  it("prefers what the server said when the server said something useful", async () => {
    const { io: deps } = io();

    const outcome = await runExport(
      { items: [audio(fails(new ExportError("This recording has no audio to convert.")))] },
      deps,
    );

    expect(outcome.failures[0].message).toBe("This recording has no audio to convert.");
  });

  it("never reports a delivery it did not make", async () => {
    // The invariant, stated directly: `delivered` is either everything or
    // nothing, and it is empty whenever anything failed.
    const { io: deps } = io();

    for (const failing of [0, 1, 2]) {
      const items = [summary(ok("s.pdf")), transcript(ok("t.txt")), audio(ok("a.mp3"))];
      items[failing] = { ...items[failing], fetch: fails(new DownloadFailure(500)) };

      const outcome = await runExport({ items }, deps);

      expect(outcome.delivered, `part ${failing}`).toEqual([]);
      expect(outcome.complete, `part ${failing}`).toBe(false);
    }
  });

  it("can succeed on a retry after a failure", async () => {
    // The dialog keeps the selection, so Try again is one click. The retry has
    // to produce the whole archive, not the parts that failed last time.
    const { io: deps, saved, bundled } = io();
    let attempt = 0;
    const flaky = () => {
      attempt++;
      return attempt === 1
        ? Promise.reject(new DownloadFailure(503))
        : Promise.resolve(file("sprint-planning.mp3"));
    };
    const plan = { items: [summary(ok("sprint-planning.pdf")), audio(flaky)] };

    const first = await runExport(plan, deps);
    const second = await runExport(plan, deps);

    expect(first.complete).toBe(false);
    expect(second.complete).toBe(true);
    expect(saved).toHaveLength(1);
    expect(bundled[0]).toEqual(["sprint-planning-summary.pdf", "sprint-planning-audio.mp3"]);
  });
});

describe("runExport: edges", () => {
  it("does nothing at all when nothing was chosen", async () => {
    const { io: deps, saved } = io();

    const outcome = await runExport({ items: [] }, deps);

    expect(saved).toHaveLength(0);
    expect(outcome).toEqual({ delivered: [], failures: [], complete: true });
  });

  it("delivers nothing when the archive cannot be built", async () => {
    // Every part arrived and the packaging failed. There is deliberately no
    // fallback to separate downloads: that is the partial delivery this exists
    // to prevent, and it would be triggered by the condition -- a very large
    // recording -- under which it is most likely to half-work.
    const { io: deps, saved } = io({
      bundle: async () => {
        throw new RangeError("Array buffer allocation failed");
      },
    });

    const outcome = await runExport(
      { items: [summary(ok("s.pdf")), audio(ok("a.mp3"))] },
      deps,
    );

    expect(saved).toEqual([]);
    expect(outcome.complete).toBe(false);
    // Not blamed on a part, because no part failed.
    expect(outcome.failures[0].part).toBeNull();
    expect(outcome.failures[0].message).not.toMatch(/allocation|RangeError/);
  });

  it("requests the parts one at a time", async () => {
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

    await runExport({ items: [summary(slow), transcript(slow), audio(slow)] }, deps);

    expect(Math.max(...inFlight)).toBe(1);
  });
});
