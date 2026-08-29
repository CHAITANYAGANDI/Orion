import { describe, it, expect } from "vitest";
import { crc32, uniqueNames, zip } from "@/lib/zip";

/**
 * An archive real software can open.
 *
 * <p>This is the one module in the frontend whose output is consumed by
 * something outside the browser — Windows Explorer, macOS Archive Utility,
 * `unzip`. There is no way to assert "it opened" from a test runner, so the
 * bytes are parsed back and checked against the specification (APPNOTE 6.3.3
 * §4.3.7, §4.3.12, §4.3.16). Every field an extractor reads to find the entries
 * is asserted, because getting one wrong produces an archive that fails with
 * "unexpected end of archive" and no clue which of the twenty little-endian
 * numbers was the problem.
 *
 * <p>The CRC is checked against the polynomial's published test vector rather
 * than against the implementation, so a table built wrongly cannot agree with
 * itself.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function text(view: DataView, at: number, length: number): string {
  return new TextDecoder().decode(new Uint8Array(view.buffer, at, length));
}

/** The end-of-central-directory record, which is where an extractor starts. */
function end(view: DataView) {
  const at = view.byteLength - 22;
  expect(view.getUint32(at, true), "end-of-central-directory signature").toBe(SIG_END);
  return {
    at,
    entries: view.getUint16(at + 10, true),
    size: view.getUint32(at + 12, true),
    offset: view.getUint32(at + 16, true),
  };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
  it("matches the published vector for the zip polynomial", () => {
    // "123456789" -> 0xCBF43926 is the standard check value for CRC-32/ISO-HDLC,
    // which is what zip uses. A table built with a wrong constant agrees with
    // itself perfectly and fails only here.
    expect(crc32(utf8("123456789")).toString(16)).toBe("cbf43926");
  });

  it("is zero for nothing", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("notices a single flipped byte", () => {
    expect(crc32(utf8("summary"))).not.toBe(crc32(utf8("summarz")));
  });
});

describe("zip", () => {
  const when = new Date(2026, 7, 29, 14, 30, 20);

  it("writes a local header, a central directory and an end record", async () => {
    const view = await bytes(
      zip([{ name: "summary.txt", bytes: utf8("hello") }], when),
    );

    expect(view.getUint32(0, true), "first local header").toBe(SIG_LOCAL);
    const tail = end(view);
    expect(tail.entries).toBe(1);
    expect(view.getUint32(tail.offset, true), "central directory").toBe(SIG_CENTRAL);
  });

  it("points the central directory at the right offsets", async () => {
    // The field that matters most and is the easiest to get silently wrong: an
    // extractor seeks to this offset and expects a local header there. Off by
    // one and the archive is unreadable, with no indication why.
    const view = await bytes(
      zip(
        [
          { name: "a.txt", bytes: utf8("first") },
          { name: "b.txt", bytes: utf8("second entry") },
        ],
        when,
      ),
    );

    const tail = end(view);
    expect(tail.entries).toBe(2);

    let at = tail.offset;
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(at, true)).toBe(SIG_CENTRAL);
      const nameLength = view.getUint16(at + 28, true);
      const localAt = view.getUint32(at + 42, true);
      expect(view.getUint32(localAt, true), `entry ${i} local header`).toBe(SIG_LOCAL);
      at += 46 + nameLength;
    }
    expect(at - tail.offset).toBe(tail.size);
    expect(at).toBe(tail.at);
  });

  it("stores the contents verbatim and says how long they are", async () => {
    const content = utf8("We agreed to move billing to Stripe.");
    const view = await bytes(zip([{ name: "summary.txt", bytes: content }], when));

    expect(view.getUint16(8, true), "compression method: STORE").toBe(0);
    expect(view.getUint32(18, true), "compressed size").toBe(content.length);
    expect(view.getUint32(22, true), "uncompressed size").toBe(content.length);
    const nameLength = view.getUint16(26, true);
    const stored = new Uint8Array(view.buffer, 30 + nameLength, content.length);
    expect(new TextDecoder().decode(stored)).toBe("We agreed to move billing to Stripe.");
  });

  it("writes a checksum every extractor will verify", async () => {
    const content = utf8("sprint planning");
    const view = await bytes(zip([{ name: "a.txt", bytes: content }], when));

    // A wrong CRC does not corrupt the file; it makes every unzip refuse it
    // with "CRC failed", which reads as a damaged download.
    expect(view.getUint32(14, true)).toBe(crc32(content));
  });

  it("flags names as UTF-8 so a Japanese title survives Windows", async () => {
    const view = await bytes(zip([{ name: "四半期.txt", bytes: utf8("x") }], when));

    // Bit 11. Without it an extractor may read the bytes as CP437, and the
    // name becomes mojibake on the platform where it is hardest to repair.
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    const nameLength = view.getUint16(26, true);
    expect(text(view, 30, nameLength)).toBe("四半期.txt");
  });

  it("carries a plausible timestamp", async () => {
    const view = await bytes(zip([{ name: "a.txt", bytes: utf8("x") }], when));

    // MS-DOS date: year since 1980 in the top 7 bits, month, day.
    const date = view.getUint16(12, true);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0xf).toBe(8);
    expect(date & 0x1f).toBe(29);
  });

  it("keeps both files when a summary and a transcript share a name", async () => {
    // Reachable from the dialog: both parts default to .txt and both are named
    // after the meeting. A zip may hold two entries with one name, and what
    // happens then is the extractor's choice -- Explorer asks, unzip
    // overwrites, and one of the two files is gone.
    const view = await bytes(
      zip(
        [
          { name: "sprint-planning.txt", bytes: utf8("summary") },
          { name: "sprint-planning.txt", bytes: utf8("transcript") },
        ],
        when,
      ),
    );

    const first = view.getUint16(26, true);
    const names = [text(view, 30, first)];
    const secondAt = 30 + first + "summary".length;
    names.push(text(view, secondAt + 30, view.getUint16(secondAt + 26, true)));

    expect(names[0]).toBe("sprint-planning.txt");
    expect(names[1]).toBe("sprint-planning (2).txt");
  });

  it("is a valid, empty archive when there is nothing to put in it", async () => {
    const view = await bytes(zip([], when));

    expect(view.byteLength).toBe(22);
    const tail = end(view);
    expect(tail.entries).toBe(0);
    expect(tail.size).toBe(0);
  });

  it("says it is a zip", async () => {
    expect(zip([{ name: "a.txt", bytes: utf8("x") }], when).type).toBe("application/zip");
  });
});

describe("uniqueNames", () => {
  it("leaves distinct names alone", () => {
    expect(uniqueNames(["a.txt", "b.pdf"])).toEqual(["a.txt", "b.pdf"]);
  });

  it("numbers the repeats before the extension", () => {
    // "meeting (2).txt", not "meeting.txt (2)" -- the second is what a naive
    // suffix produces and it costs the file its file type on Windows.
    expect(uniqueNames(["m.txt", "m.txt", "m.txt"])).toEqual([
      "m.txt",
      "m (2).txt",
      "m (3).txt",
    ]);
  });

  it("copes with a name that has no extension", () => {
    expect(uniqueNames(["notes", "notes"])).toEqual(["notes", "notes (2)"]);
  });

  it("does not mistake a leading dot for an extension", () => {
    expect(uniqueNames([".hidden", ".hidden"])).toEqual([".hidden", ".hidden (2)"]);
  });
});
