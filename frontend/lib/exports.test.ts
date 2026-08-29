import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }));
vi.mock("@/lib/auth-store", () => ({ buildAuthHeaders: async () => ({}) }));

import {
  bundleName,
  buildBundle,
  describeExportFailure,
  DownloadFailure,
  entryName,
  exportPath,
  ExportError,
  fetchExportFile,
  fetchSignedFile,
  filenameFrom,
  isTransientFailure,
  REVOKE_DELAY_MS,
  save,
} from "@/lib/exports";

/**
 * Asking for a file, and knowing what it is called when it arrives.
 *
 * <p>The query string is the whole interface to the export — get a parameter
 * wrong and the file that lands is the right meeting in the wrong language, or
 * two pages where forty were wanted, with nothing on screen to say so. The
 * header parsing is the other half: a name that does not survive the trip turns
 * a downloads folder into a list of "meeting (3)".
 *
 * <p>The rest of this file is about the export that was reported as
 * intermittent. Three things were producing that and none of them was a flaky
 * network: an object URL revoked before the browser had read it, a retry that
 * did not exist, and failure messages that named neither the part nor anything
 * a person could act on.
 */
describe("exportPath", () => {
  it("asks for the format", () => {
    expect(exportPath("mtg_1", "pdf", {}, null)).toBe("/meetings/mtg_1/export?format=pdf");
  });

  it("leaves the transcript out unless it was asked for", () => {
    // Absent rather than false: the transcript is ten to a hundred times the
    // length of everything else, and the default has to be the small file.
    expect(exportPath("mtg_1", "docx", { transcript: false }, null)).not.toContain("transcript");
    expect(exportPath("mtg_1", "docx", { transcript: true }, null)).toContain("transcript=true");
  });

  it("carries the language the page is being read in", () => {
    expect(exportPath("mtg_1", "pdf", { language: "es" }, null)).toContain("language=es");
  });

  it("omits the language when reading the original", () => {
    // An empty language would be sent as `language=` and read by the server as
    // a request to translate into nothing.
    expect(exportPath("mtg_1", "pdf", { language: null }, null)).not.toContain("language");
  });

  it("sends the reader's time zone", () => {
    // 23:30 in London is the next day in Tokyo. A file dated a day off from the
    // page it was exported from looks like the wrong meeting.
    expect(exportPath("mtg_1", "pdf", {}, "Asia/Tokyo")).toContain("tz=Asia%2FTokyo");
  });
});

describe("filenameFrom", () => {
  it("prefers the encoded name over the lossy one", () => {
    const header =
      "attachment; filename=\"meeting.pdf\"; filename*=UTF-8''%E5%9B%9B%E5%8D%8A%E6%9C%9F.pdf";

    // The plain form is a deliberate fallback for old clients and would
    // otherwise win by being written first.
    expect(filenameFrom(header, "fallback.pdf")).toBe("四半期.pdf");
  });

  it("reads the plain name when there is no encoded one", () => {
    expect(filenameFrom('attachment; filename="sprint-planning.docx"', "fallback.docx")).toBe(
      "sprint-planning.docx",
    );
  });

  it("falls back when there is no header at all", () => {
    expect(filenameFrom(null, "meeting.txt")).toBe("meeting.txt");
  });

  it("falls back rather than failing on broken percent-encoding", () => {
    expect(filenameFrom("attachment; filename*=UTF-8''%E5%9B", "meeting.pdf")).toBe("meeting.pdf");
  });
});

/* -------------------------------------------------------------------------- */

describe("isTransientFailure", () => {
  it("is true for a network that dropped", () => {
    // `fetch` rejects with a TypeError. The wording differs by engine —
    // "Failed to fetch", "NetworkError when attempting to fetch resource" — so
    // this must never be decided by reading the message.
    expect(isTransientFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it.each([502, 503, 504])("is true for a gateway answering %s", (status) => {
    expect(isTransientFailure(new DownloadFailure(status))).toBe(true);
    expect(isTransientFailure({ status, data: {} })).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 429])("is false for %s", (status) => {
    // The server has decided. Asking again produces the same answer and
    // doubles the load; a 429 in particular is a request to stop.
    expect(isTransientFailure(new DownloadFailure(status))).toBe(false);
    expect(isTransientFailure({ status, data: {} })).toBe(false);
  });

  it("is false for a 500", () => {
    // The request reached the application and broke it. Repeating it repeats
    // the bug, one second later, with the same outcome.
    expect(isTransientFailure(new DownloadFailure(500))).toBe(false);
  });

  it("is true for RTK Query's transport statuses and false for its parse one", () => {
    expect(isTransientFailure({ status: "FETCH_ERROR", error: "offline" })).toBe(true);
    expect(isTransientFailure({ status: "TIMEOUT_ERROR", error: "slow" })).toBe(true);
    // A body that is not what it claimed to be will not become one on a second
    // attempt.
    expect(isTransientFailure({ status: "PARSING_ERROR", originalStatus: 200 })).toBe(false);
  });

  it("is false for things that are not failures it understands", () => {
    for (const error of [null, undefined, {}, "boom", new Error("boom"), 502]) {
      expect(isTransientFailure(error), JSON.stringify(error)).toBe(false);
    }
  });
});

describe("describeExportFailure", () => {
  it("names the part that failed", () => {
    // "Couldn't export this meeting" after choosing three things leaves
    // somebody checking their downloads folder to work out which arrived.
    expect(describeExportFailure("summary", new DownloadFailure(500))).toContain(
      "Couldn't export the summary",
    );
    expect(describeExportFailure("transcript", new DownloadFailure(500))).toContain(
      "Couldn't export the transcript",
    );
    expect(describeExportFailure("audio", new DownloadFailure(500))).toContain(
      "Couldn't export the audio",
    );
  });

  it("repeats a sentence the server wrote for a person", () => {
    // The whole value of the server's message: "this meeting has not been
    // translated into German" is the entire answer, and no wording invented
    // here could match it.
    const message = "This meeting has not been translated into German.";
    expect(describeExportFailure("summary", new ExportError(message))).toBe(message);
    expect(
      describeExportFailure("audio", { status: 400, data: { message } }),
    ).toBe(message);
  });

  it("does not repeat a 5xx body", () => {
    // Spring's 500 says "An unexpected error occurred", and when a proxy
    // answers instead it is a page of HTML. Neither belongs on screen, and the
    // second is how technical detail leaks into a UI.
    const said = describeExportFailure("summary", {
      status: 500,
      data: { message: "An unexpected error occurred" },
    });

    expect(said).toBe("Couldn't export the summary.");
  });

  it("never leaks a status code, a stack or the browser's phrasing", () => {
    for (const error of [
      new DownloadFailure(502),
      new DownloadFailure("FETCH_ERROR"),
      new TypeError("Failed to fetch"),
      { status: 503, data: "<html><body>502 Bad Gateway</body></html>" },
      { status: "PARSING_ERROR", originalStatus: 200, data: "not json" },
      new Error("at Object.<anonymous> (/app/x.js:1:1)"),
    ]) {
      const said = describeExportFailure("transcript", error);
      expect(said).not.toMatch(/\d{3}\b/);
      expect(said).not.toMatch(/Failed to fetch|html|at Object/i);
      expect(said).toContain("Couldn't export the transcript");
    }
  });

  it("refuses a server 'message' that is really a stack trace", () => {
    const stack = "NullPointerException\n\tat com.orion.Export.render(Export.java:41)";

    expect(describeExportFailure("summary", { status: 400, data: { message: stack } })).toBe(
      "Couldn't export the summary.",
    );
  });

  it("suggests the connection only when that is plausibly the problem", () => {
    expect(describeExportFailure("summary", new TypeError("Failed to fetch"))).toContain(
      "Check your connection",
    );
    expect(describeExportFailure("summary", new DownloadFailure(500))).not.toContain(
      "Check your connection",
    );
  });
});

/* -------------------------------------------------------------------------- */

const disposition = (name: string) => ({
  "Content-Disposition": `attachment; filename="${name}"`,
});

function ok(name = "sprint-planning.txt", body = "summary") {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => disposition(name)[h as "Content-Disposition"] ?? null },
    blob: async () => new Blob([body], { type: "text/plain" }),
    json: async () => ({}),
  };
}

function failing(status: number, body?: unknown) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    blob: async () => new Blob([]),
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  };
}

describe("fetchExportFile", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the bytes and the name the server chose", async () => {
    fetchMock.mockResolvedValue(ok("四半期.pdf"));

    const file = await fetchExportFile("mtg_1", "pdf", {}, 0);

    expect(file.filename).toBe("四半期.pdf");
    expect(new TextDecoder().decode(await file.blob.arrayBuffer())).toBe("summary");
  });

  it("tries once more when the first attempt fails in transit", async () => {
    // The requirement, precisely: a transient failure followed by success is a
    // successful export, not a message.
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok());

    const file = await fetchExportFile("mtg_1", "txt", {}, 0);

    expect(file.filename).toBe("sprint-planning.txt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("tries once more after a %s", async (status) => {
    fetchMock.mockResolvedValueOnce(failing(status)).mockResolvedValueOnce(ok());

    await expect(fetchExportFile("mtg_1", "txt", {}, 0)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries once more, and only once", async () => {
    // Two attempts, not three. Each further one buys less and makes a
    // genuinely broken export take longer to say so.
    fetchMock.mockResolvedValue(failing(503));

    await expect(fetchExportFile("mtg_1", "txt", {}, 0)).rejects.toBeInstanceOf(DownloadFailure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 429, 500])("does not retry a %s", async (status) => {
    fetchMock.mockResolvedValue(failing(status, { message: "" }));

    await expect(fetchExportFile("mtg_1", "txt", {}, 0)).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a 4xx explanation the server wrote", async () => {
    fetchMock.mockResolvedValue(
      failing(404, { message: "This meeting has not been translated into German." }),
    );

    await expect(fetchExportFile("mtg_1", "pdf", {}, 0)).rejects.toBeInstanceOf(ExportError);
  });

  it("does not quote a 5xx body, even when it parses", async () => {
    // A proxy's HTML page and Spring's generic "An unexpected error occurred"
    // both land here, and neither is a sentence for a user.
    fetchMock.mockResolvedValue(failing(500, { message: "An unexpected error occurred" }));

    await expect(fetchExportFile("mtg_1", "pdf", {}, 0)).rejects.toBeInstanceOf(DownloadFailure);
  });

  it("survives a 5xx whose body is not JSON at all", async () => {
    // A 502 from a gateway is an HTML page; a truncated response is nothing.
    // Both used to reach `response.json()`, and the throw from there must not
    // become the error the user sees.
    fetchMock.mockResolvedValue(failing(500));

    await expect(fetchExportFile("mtg_1", "pdf", {}, 0)).rejects.toBeInstanceOf(DownloadFailure);
  });

  it("never mistakes a transport failure for a finished download", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    // The rule the whole feature rests on: no path returns a file when none
    // arrived.
    await expect(fetchExportFile("mtg_1", "txt", {}, 0)).rejects.toBeInstanceOf(TypeError);
  });
});

/* -------------------------------------------------------------------------- */

describe("save", () => {
  const createObjectURL = vi.fn(() => "blob:orion/1");
  const revokeObjectURL = vi.fn();
  let click: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    // Anchors from an earlier test outlive it: switching back to real timers
    // discards the pending cleanup rather than running it.
    document.body.innerHTML = "";
    // jsdom has no navigation, so a real click on a download link raises
    // "Not implemented: navigation" from inside a timer -- noise that would
    // bury a genuine failure here one day.
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    click.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not revoke the object URL in the same tick as the click", () => {
    // THE intermittent-download bug. A browser schedules the download and
    // reads the blob URL afterwards; revoking it immediately is a race against
    // the download the user asked for, which a fast machine usually wins and a
    // slow one sometimes does not. Nothing throws when it loses.
    save(new Blob(["x"]), "summary.txt");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes it once the download has had time to start", () => {
    save(new Blob(["x"]), "summary.txt");

    vi.advanceTimersByTime(REVOKE_DELAY_MS);

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:orion/1");
  });

  it("gives the browser long enough to be sure", () => {
    // Not a number picked to make a test pass: it has to exceed the time any
    // browser takes to begin reading a blob it has been handed.
    expect(REVOKE_DELAY_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("clicks a link carrying the filename", () => {
    save(new Blob(["x"]), "四半期.pdf");

    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")?.getAttribute("download")).toBe("四半期.pdf");
  });

  it("leaves nothing in the document afterwards", () => {
    save(new Blob(["x"]), "summary.txt");
    vi.advanceTimersByTime(REVOKE_DELAY_MS);

    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("bundling", () => {
  it("puts every selected part in one archive", async () => {
    const blob = await buildBundle([
      { blob: new Blob(["summary"]), filename: "sprint-planning-summary.txt" },
      { blob: new Blob(["transcript"]), filename: "sprint-planning-transcript.md" },
      { blob: new Blob(["audio"]), filename: "sprint-planning-audio.mp3" },
    ]);

    const view = new DataView(await blob.arrayBuffer());
    // Three entries, counted where an extractor counts them.
    expect(view.getUint16(view.byteLength - 12, true)).toBe(3);
    expect(blob.type).toBe("application/zip");
  });

  it("names the archive after the meeting", async () => {
    // What somebody will search for in a downloads folder six months later.
    expect(
      bundleName([
        { blob: new Blob([]), filename: "sprint-planning-summary.txt" },
        { blob: new Blob([]), filename: "sprint-planning-audio.mp3" },
      ]),
    ).toBe("sprint-planning-summary-export.zip");
  });

  it("has a name even for a file that had none", () => {
    expect(bundleName([])).toBe("meeting-export.zip");
  });
});

describe("entryName", () => {
  it("spells out which part a file is", () => {
    // The server names both documents after the meeting, so a summary and a
    // transcript exported in the same format arrive under one name. Inside an
    // archive that means an extractor may overwrite one with the other.
    expect(entryName("summary", "sprint-planning.txt")).toBe("sprint-planning-summary.txt");
    expect(entryName("transcript", "sprint-planning.txt")).toBe(
      "sprint-planning-transcript.txt",
    );
  });

  it("keeps the extension, which is what opens the file", () => {
    expect(entryName("audio", "sprint-planning.mp3")).toBe("sprint-planning-audio.mp3");
    expect(entryName("summary", "四半期.pdf")).toBe("四半期-summary.pdf");
  });

  it("copes with a name that has no extension", () => {
    expect(entryName("summary", "meeting")).toBe("meeting-summary");
  });
});

describe("fetchSignedFile", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const audio = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    blob: async () => new Blob([new Uint8Array([0xff, 0xfb, 0x90])], { type: "audio/mpeg" }),
  });

  it("returns the bytes under the name the API chose", async () => {
    fetchMock.mockResolvedValue(audio());

    const file = await fetchSignedFile("https://r2/signed.mp3", "sprint-planning.mp3", 0);

    expect(file.filename).toBe("sprint-planning.mp3");
    expect(new Uint8Array(await file.blob.arrayBuffer())[0]).toBe(0xff);
  });

  it("sends no headers at all", async () => {
    // The credential is in the URL. An Authorization header would fall outside
    // the signature and, worse, turn a simple cross-origin GET into a
    // preflighted one that the bucket has to be configured to answer.
    fetchMock.mockResolvedValue(audio());

    await fetchSignedFile("https://r2/signed.mp3", "a.mp3", 0);

    expect(fetchMock).toHaveBeenCalledWith("https://r2/signed.mp3");
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  it("tries once more when the connection drops", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(audio());

    await expect(fetchSignedFile("https://r2/x.mp3", "a.mp3", 0)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an expired signature", async () => {
    // Object storage answers an expired or malformed signature with 403. It
    // will answer the same way a second later; the fix is a fresh URL, which
    // is a level up from here.
    fetchMock.mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });

    await expect(fetchSignedFile("https://r2/x.mp3", "a.mp3", 0)).rejects.toBeInstanceOf(
      DownloadFailure,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never quotes object storage's error document", async () => {
    // R2 and S3 answer with XML naming the bucket, the key and a request id.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => "<Error><Key>meetings/usr_1/mtg_1/a.webm.mp3</Key></Error>",
    });

    const failure = await fetchSignedFile("https://r2/x.mp3", "a.mp3", 0).catch((e) => e);

    expect(describeExportFailure("audio", failure)).toBe("Couldn't export the audio.");
  });
});
