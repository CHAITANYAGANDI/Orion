import { describe, it, expect } from "vitest";
import {
  CRC_CHUNK_BYTES,
  crc32,
  crc32Blob,
  uniqueNames,
  zip,
} from "@/lib/zip";

/**
 * An archive real software can open, built without copying the recording.
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
 *
 * <p>The last section is about memory. The archive now carries the meeting's
 * recording, which is a hundred megabytes for a long call, and the old
 * `Uint8Array` shape held three copies of it at once. Those tests fail if that
 * ever comes back.
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
const file = (name: string, body: string) => ({ name, blob: new Blob([body]) });

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

describe("crc32Blob", () => {
  it("agrees with the one-shot version", async () => {
    const body = "We agreed to move billing to Stripe.";

    expect(await crc32Blob(new Blob([body]))).toBe(crc32(utf8(body)));
  });

  it("agrees with it across chunk boundaries", async () => {
    // The incremental form exists so a hundred-megabyte recording never becomes
    // one array. If the running value were reset or finalised per chunk, this
    // is the only test that would notice -- a single-chunk file would still be
    // right.
    const body = "abcdefghij".repeat(50);

    for (const chunk of [1, 3, 7, 64, 499, 10_000]) {
      expect(await crc32Blob(new Blob([body]), chunk), `chunk ${chunk}`).toBe(
        crc32(utf8(body)),
      );
    }
  });

  it("is zero for an empty blob", async () => {
    expect(await crc32Blob(new Blob([]))).toBe(0);
  });
});

describe("zip", () => {
  const when = new Date(2026, 7, 29, 14, 30, 20);

  it("writes a local header, a central directory and an end record", async () => {
    const view = await bytes(await zip([file("summary.txt", "hello")], when));

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
      await zip([file("a.txt", "first"), file("b.txt", "second entry")], when),
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
    const body = "We agreed to move billing to Stripe.";
    const view = await bytes(await zip([file("summary.txt", body)], when));

    expect(view.getUint16(8, true), "compression method: STORE").toBe(0);
    expect(view.getUint32(18, true), "compressed size").toBe(body.length);
    expect(view.getUint32(22, true), "uncompressed size").toBe(body.length);
    const nameLength = view.getUint16(26, true);
    const stored = new Uint8Array(view.buffer, 30 + nameLength, body.length);
    expect(new TextDecoder().decode(stored)).toBe(body);
  });

  it("writes a checksum every extractor will verify", async () => {
    const body = "sprint planning";
    const view = await bytes(await zip([file("a.txt", body)], when));

    // A wrong CRC does not corrupt the file; it makes every unzip refuse it
    // with "CRC failed", which reads as a damaged download.
    expect(view.getUint32(14, true)).toBe(crc32(utf8(body)));
  });

  it("flags names as UTF-8 so a Japanese title survives Windows", async () => {
    const view = await bytes(await zip([file("四半期.txt", "x")], when));

    // Bit 11. Without it an extractor may read the bytes as CP437, and the
    // name becomes mojibake on the platform where it is hardest to repair.
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    const nameLength = view.getUint16(26, true);
    expect(text(view, 30, nameLength)).toBe("四半期.txt");
  });

  it("carries a plausible timestamp", async () => {
    const view = await bytes(await zip([file("a.txt", "x")], when));

    // MS-DOS date: year since 1980 in the top 7 bits, month, day.
    const date = view.getUint16(12, true);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0xf).toBe(8);
    expect(date & 0x1f).toBe(29);
  });

  it("keeps both files when two entries share a name", async () => {
    // The export names entries per part now, so this should not arise -- but a
    // zip may hold two entries with one name, and what happens then is the
    // extractor's choice: Explorer asks, unzip overwrites, and one of the files
    // the user asked for is quietly gone.
    const view = await bytes(
      await zip([file("m.txt", "summary"), file("m.txt", "transcript")], when),
    );

    const first = view.getUint16(26, true);
    const names = [text(view, 30, first)];
    const secondAt = 30 + first + "summary".length;
    names.push(text(view, secondAt + 30, view.getUint16(secondAt + 26, true)));

    expect(names).toEqual(["m.txt", "m (2).txt"]);
  });

  it("is a valid, empty archive when there is nothing to put in it", async () => {
    const view = await bytes(await zip([], when));

    expect(view.byteLength).toBe(22);
    const tail = end(view);
    expect(tail.entries).toBe(0);
    expect(tail.size).toBe(0);
  });

  it("says it is a zip", async () => {
    expect((await zip([file("a.txt", "x")], when)).type).toBe("application/zip");
  });

  it("stores binary entries byte for byte", async () => {
    // The MP3 goes in here. Anything that decoded and re-encoded it -- a
    // TextDecoder anywhere in the path -- would replace every byte above 0x7F
    // with U+FFFD and produce an archive full of plausible-looking noise.
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x49, 0x44, 0x33, 0x80]);
    const view = await bytes(await zip([{ name: "a.mp3", blob: new Blob([audio]) }], when));

    const nameLength = view.getUint16(26, true);
    const stored = new Uint8Array(view.buffer, 30 + nameLength, audio.length);
    expect([...stored]).toEqual([...audio]);
  });
});

/**
 * A Blob that says how it was read.
 *
 * <p>Subclassed rather than proxied so it really is a Blob: the archive passes
 * entries straight into the `Blob` constructor, and a stand-in that only looked
 * like one would be testing the stand-in.
 */
class WatchedBlob extends Blob {
  readonly reads: number[] = [];
  fullReads = 0;

  slice(start?: number, end?: number, type?: string): Blob {
    this.reads.push((end ?? this.size) - (start ?? 0));
    return super.slice(start, end, type);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    this.fullReads++;
    return super.arrayBuffer();
  }
}

describe("zip memory", () => {
  /**
   * Comfortably larger than one chunk, small enough that jsdom is quick about
   * it. The point is only that more than one chunk is needed.
   */
  const BIG = CRC_CHUNK_BYTES * 2 + 1234;

  function recording(): WatchedBlob {
    return new WatchedBlob([new Uint8Array(BIG).fill(0x5a)], { type: "audio/mpeg" });
  }

  it("never reads a whole entry into one array", async () => {
    // The regression this section exists for. `crc32Blob` has to see every byte
    // -- the format requires a checksum -- but it must see them a chunk at a
    // time. `await blob.arrayBuffer()` on a hundred-megabyte recording is a
    // hundred megabytes of JS heap, and the old shape did it twice.
    const audio = recording();

    await zip([{ name: "meeting-audio.mp3", blob: audio }]);

    expect(audio.fullReads, "whole-file reads").toBe(0);
    expect(Math.max(...audio.reads), "largest single read").toBeLessThanOrEqual(
      CRC_CHUNK_BYTES,
    );
  });

  it("reads each entry exactly once", async () => {
    // Twice would mean the checksum pass and the assembly pass both walk the
    // file -- which is what passing Blobs into the Blob constructor avoids, and
    // what converting them to arrays would reintroduce.
    const audio = recording();

    await zip([{ name: "meeting-audio.mp3", blob: audio }]);

    const total = audio.reads.reduce((a, b) => a + b, 0);
    expect(total).toBe(BIG);
  });

  it("still produces an archive of the right size", async () => {
    // The memory assertions above would all pass for an archive that dropped
    // the audio entirely.
    const audio = recording();
    const name = "meeting-audio.mp3";

    const archive = await zip([{ name, blob: audio }]);

    // local header + name + payload + central record + name + end record
    expect(archive.size).toBe(30 + name.length + BIG + 46 + name.length + 22);
  });

  it("declares the true size of a large entry in both headers", async () => {
    const audio = recording();

    const view = await bytes(await zip([{ name: "a.mp3", blob: audio }]));

    expect(view.getUint32(18, true)).toBe(BIG);
    expect(view.getUint32(22, true)).toBe(BIG);
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
