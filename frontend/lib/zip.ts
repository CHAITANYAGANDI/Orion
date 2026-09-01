/**
 * One download instead of several.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Exporting a summary and a transcript used to be two programmatic clicks on
 * two synthetic links, one after the other. Browsers treat that as a site
 * downloading files nobody asked for: Chrome raises "allow multiple downloads?"
 * and, if the prompt is dismissed or previously denied for the origin, drops
 * everything after the first one silently. Firefox and Safari have their own
 * versions of the same defence. Nothing throws, nothing is logged, and the user
 * sees an export that half worked.
 *
 * <p>So when more than one thing is selected they go into one archive and the
 * browser is asked for exactly one file. That is not a workaround for a browser
 * bug — it is what the browsers are asking for.
 *
 * <h2>Why it is written here rather than installed</h2>
 *
 * <p>Everything Reverie exports arrives already compressed. A PDF has Flate
 * streams inside it, a .docx <em>is</em> a zip, and an MP3 is a lossy codec's
 * output; deflating any of them buys single-digit percentages for a
 * general-purpose compressor and costs a pass over the whole file. So this
 * writes the STORE method — entries stored verbatim — which is a few hundred
 * bytes of well-specified header arithmetic (APPNOTE 6.3.3, sections 4.3.7,
 * 4.3.12 and 4.3.16) rather than a compression library.
 *
 * <p>Markdown and plain text would compress, and deliberately are not. A
 * transcript is the one export somebody might open in Notepad straight out of
 * the archive on a machine with no unzip tool, and Windows Explorer, macOS
 * Archive Utility and every command-line unzip read STORE without a codec.
 *
 * <h2>Blobs in, Blob out — nothing large is ever a Uint8Array</h2>
 *
 * <p>This used to take {@code Uint8Array} entries and assemble the archive into
 * one {@code new Uint8Array(totalSize)}. For a summary and a transcript that was
 * a few hundred kilobytes and perfectly reasonable. It stopped being reasonable
 * when the recording joined the archive: a two-hour meeting is a hundred
 * megabytes or more, and that shape held <em>three</em> copies of it in the JS
 * heap at once — the decoded response, the entry array, and the output buffer.
 *
 * <p>So entries are {@link Blob}s and stay {@link Blob}s. A Blob is a handle to
 * bytes the browser owns and may keep on disk; passing one into the
 * {@code Blob} constructor references it rather than copying it into script
 * memory. Only the 30- and 46-byte headers are ever materialised here.
 *
 * <p>The one thing that genuinely has to read every byte is the CRC — the format
 * requires it, and no arrangement of headers avoids it. {@link crc32Blob} does
 * that a megabyte at a time, so peak cost is {@link CRC_CHUNK_BYTES} rather than
 * the size of the file.
 *
 * <p>No Zip64. A single entry or a total above 4 GiB would need it; Reverie's
 * longest recordings are two orders of magnitude below that, and an archive
 * approaching it would be a bug worth failing on rather than one worth writing.
 */

/**
 * CRC-32 as the zip format wants it: reflected, polynomial 0xEDB88320, with
 * pre- and post-inversion.
 *
 * <p>The table is built once on first use rather than written out, because a
 * 256-entry literal is 256 opportunities for a typo that produces an archive
 * every tool refuses with "CRC failed" and no clue which entry is wrong.
 */
let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    built[n] = c >>> 0;
  }
  table = built;
  return built;
}

/** The running value before any bytes have been seen. */
export const CRC_INIT = 0xffffffff;

/**
 * Fold more bytes into a running CRC.
 *
 * <p>Split out from {@link crc32} so a hundred-megabyte recording can be
 * checksummed a chunk at a time without ever existing as one array.
 */
export function crc32Update(running: number, bytes: Uint8Array): number {
  const t = crcTable();
  let c = running;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** Turn a running value into the number that goes in the header. */
export function crc32Finish(running: number): number {
  return (running ^ 0xffffffff) >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  return crc32Finish(crc32Update(CRC_INIT, bytes));
}

/**
 * How much of a file is in memory at once while its checksum is computed.
 *
 * <p>A megabyte: small enough that a hundred-megabyte recording costs a
 * megabyte, large enough that the per-chunk overhead disappears.
 */
export const CRC_CHUNK_BYTES = 1024 * 1024;

/**
 * The checksum of a Blob, without reading it all into memory.
 *
 * <p>`slice` on a Blob is a view, not a copy — the browser hands back a handle
 * to a range of the same underlying bytes — so only the chunk that is actually
 * decoded ever occupies script memory.
 *
 * <p>Deliberately not `blob.stream()`, which every browser has and jsdom does
 * not. One path that works everywhere beats a fast path plus a fallback, when
 * the two have the same memory bound and only one of them is exercised by the
 * tests.
 */
export async function crc32Blob(blob: Blob, chunkBytes = CRC_CHUNK_BYTES): Promise<number> {
  let running = CRC_INIT;
  for (let at = 0; at < blob.size; at += chunkBytes) {
    const chunk = await blob.slice(at, Math.min(at + chunkBytes, blob.size)).arrayBuffer();
    running = crc32Update(running, new Uint8Array(chunk));
  }
  return crc32Finish(running);
}

export interface ZipEntry {
  /** The name inside the archive, which is what the user sees when they open it. */
  name: string;
  blob: Blob;
}

/** MS-DOS date and time, which is what a zip local header carries. */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Make the names inside the archive unique, and keep them recognisable.
 *
 * <p>The entries are named per part now, so a collision needs two parts of the
 * same name — which the caller does not produce. This stays as the backstop,
 * because a zip is permitted to contain two entries with one name and what
 * happens then depends entirely on the extractor: Explorer asks, `unzip`
 * overwrites, and one of the files the user asked for is quietly gone.
 */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const taken = seen.get(name) ?? 0;
    seen.set(name, taken + 1);
    if (taken === 0) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = dot <= 0 ? "" : name.slice(dot);
    return `${stem} (${taken + 1})${ext}`;
  });
}

/**
 * A zip archive containing the entries, stored uncompressed.
 *
 * @param when the timestamp written into every entry; injectable so a test can
 *             assert bytes rather than assert around a clock
 */
export async function zip(entries: ZipEntry[], when: Date = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const stamp = dosStamp(when);
  const names = uniqueNames(entries.map((e) => e.name)).map((name) => encoder.encode(name));
  const sums = await Promise.all(entries.map((entry) => crc32Blob(entry.blob)));

  /*
   * The archive as a list of parts rather than one buffer. Headers are tiny and
   * are built here; payloads are the caller's Blobs, passed straight through.
   * The Blob constructor references them -- it does not pull them into script
   * memory -- which is the whole reason a hundred-megabyte recording can go in
   * an archive this tab assembles.
   */
  const local: BlobPart[] = [];
  const central: BlobPart[] = [];
  let at = 0;
  const offsets: number[] = [];

  entries.forEach((entry, i) => {
    const name = names[i];
    const size = entry.blob.size;
    offsets.push(at);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed: 2.0, which is STORE
    // Bit 11 is the "the name is UTF-8" flag. Without it an extractor is
    // entitled to read the bytes as CP437, and a meeting called 四半期レビュー
    // extracts as mojibake -- on the one platform, Windows, where the name is
    // also the hardest to fix afterwards.
    header.setUint16(6, 0x0800, true);
    header.setUint16(8, 0, true); // STORE
    header.setUint16(10, stamp.time, true);
    header.setUint16(12, stamp.date, true);
    header.setUint32(14, sums[i], true);
    header.setUint32(18, size, true); // compressed
    header.setUint32(22, size, true); // uncompressed; the same, being STORE
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true); // no extra field
    local.push(new Uint8Array(header.buffer), name, entry.blob);

    at += 30 + name.length + size;
  });

  const centralAt = at;
  let centralSize = 0;

  entries.forEach((entry, i) => {
    const name = names[i];
    const size = entry.blob.size;

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true); // STORE
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, sums[i], true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true); // extra
    record.setUint16(32, 0, true); // comment
    record.setUint16(34, 0, true); // disk number
    record.setUint16(36, 0, true); // internal attributes
    record.setUint32(38, 0, true); // external attributes
    record.setUint32(42, offsets[i], true);
    central.push(new Uint8Array(record.buffer), name);

    centralSize += 46 + name.length;
  });

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true); // this disk
  end.setUint16(6, 0, true); // disk with the central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralAt, true);
  end.setUint16(20, 0, true); // no archive comment

  return new Blob([...local, ...central, new Uint8Array(end.buffer)], {
    type: "application/zip",
  });
}
