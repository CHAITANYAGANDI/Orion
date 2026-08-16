import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test" }));
vi.mock("@/lib/auth-store", () => ({ buildAuthHeaders: async () => ({}) }));

import { exportPath, filenameFrom } from "@/lib/exports";

/**
 * Asking for a file, and knowing what it is called when it arrives.
 *
 * <p>The query string is the whole interface to the export — get a parameter
 * wrong and the file that lands is the right meeting in the wrong language, or
 * two pages where forty were wanted, with nothing on screen to say so. The
 * header parsing is the other half: a name that does not survive the trip turns
 * a downloads folder into a list of "meeting (3)".
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

  it("falls back when the header is missing", () => {
    // Cross-origin without the header exposed, which is the state this was in
    // before Content-Disposition was added to the CORS allow-list.
    expect(filenameFrom(null, "meeting.txt")).toBe("meeting.txt");
  });

  it("drops to the plain name rather than throwing on a mangled encoding", () => {
    // Truncated percent-encoding. The lossy name is still a better answer than
    // a generic one, and far better than a thrown error losing the download.
    expect(filenameFrom("attachment; filename=\"a.md\"; filename*=UTF-8''%E5%9B%", "b.md")).toBe(
      "a.md",
    );
  });

  it("falls back when there is nothing usable at all", () => {
    expect(filenameFrom("attachment; filename*=UTF-8''%E5%9B%", "b.md")).toBe("b.md");
  });
});
