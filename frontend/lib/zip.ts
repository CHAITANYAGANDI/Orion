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
 * <p>So when there is more than one document, they go into one archive and the
 * browser is asked for exactly one file. That is not a workaround for a browser
 * bug — it is what the browsers are asking for.
 *
 * <h2>Why it is written here rather than installed</h2>
 *
 * <p>Everything Orion exports arrives already compressed. A PDF has Flate
 * streams inside it and a .docx <em>is</em> a zip; deflating them again buys
 * single-digit percentages for a general-purpose compressor in every bundle. So
 * this writes the STORE method — entries stored verbatim — which is a few
 * hundred bytes of well-specified header arithmetic (APPNOTE 6.3.3, sections
 * 4.3.7, 4.3.12 and 4.3.16) rather than a compression library.
 *
 * <p>Markdown and plain text would compress, and deliberately are not. A
 * transcript is the one export somebody might open in Notepad straight out of
 * the archive on a machine with no unzip tool, and Windows Explorer, macOS
 * Archive Utility and every command-line unzip read STORE without a codec.
 *
 * <p>No Zip64. The four documents Orion writes are measured in megabytes and
 * the format's 4 GiB limit is not reachable from here; a bundle that could
 * approach it would be a bug worth failing on rather than an archive worth
 * writing.
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

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** The name inside the archive, which is what the user sees when they open it. */
  name: string;
  bytes: Uint8Array;
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
 * <p>Two exports of the same meeting in the same format cannot happen from one
 * dialog, but a summary and a transcript both named after the meeting can
 * collide the moment the formats match — {@code sprint-planning.txt} twice. A
 * zip is permitted to contain two entries with one name and what happens next
 * depends entirely on the extractor: Explorer asks, `unzip` overwrites, and one
 * of the two files the user asked for is gone.
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
export function zip(entries: ZipEntry[], when: Date = new Date()): Blob {
  const encoder = new TextEncoder();
  const stamp = dosStamp(when);
  const names = uniqueNames(entries.map((e) => e.name)).map((name) => encoder.encode(name));
  const sums = entries.map((entry) => crc32(entry.bytes));

  /*
   * One allocation, written in place. The format is nothing but offsets into
   * itself — the central directory points at the local headers and the end
   * record points at the central directory — so laying it out as a single
   * buffer with an explicit cursor is both the clearest way to write it and the
   * only way to be sure the offsets recorded are the offsets used.
   */
  const localSize = entries.reduce(
    (total, entry, i) => total + 30 + names[i].length + entry.bytes.length,
    0,
  );
  const centralSize = names.reduce((total, name) => total + 46 + name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);

  let at = 0;
  const offsets: number[] = [];
  entries.forEach((entry, i) => {
    const name = names[i];
    const size = entry.bytes.length;
    offsets.push(at);

    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true); // version needed: 2.0, which is STORE
    // Bit 11 is the "the name is UTF-8" flag. Without it an extractor is
    // entitled to read the bytes as CP437, and a meeting called 四半期レビュー
    // extracts as mojibake -- on the one platform, Windows, where the name is
    // also the hardest to fix afterwards.
    view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true); // STORE
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, sums[i], true);
    view.setUint32(at + 18, size, true); // compressed
    view.setUint32(at + 22, size, true); // uncompressed; the same, being STORE
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(name, at + 30);
    out.set(entry.bytes, at + 30 + name.length);
    at += 30 + name.length + size;
  });

  const centralAt = at;
  entries.forEach((entry, i) => {
    const name = names[i];
    const size = entry.bytes.length;

    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true); // STORE
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, sums[i], true);
    view.setUint32(at + 20, size, true);
    view.setUint32(at + 24, size, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk number
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i], true);
    out.set(name, at + 46);
    at += 46 + name.length;
  });

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true); // this disk
  view.setUint16(at + 6, 0, true); // disk with the central directory
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true); // no archive comment

  return new Blob([out], { type: "application/zip" });
}
