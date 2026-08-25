/**
 * Turning whatever a person picked into a profile picture.
 *
 * A phone camera produces a four-megabyte twelve-megapixel JPEG. The thing it
 * ends up as is a 96-pixel circle. Sending the original would put megabytes in
 * a database row to render something the size of a postage stamp, so everything
 * is downscaled and re-encoded here, in the browser, before it is ever sent.
 *
 * Square-cropped from the centre rather than squashed: the avatar is drawn in a
 * circle everywhere it appears, and a rectangular image scaled to fit it comes
 * out as a stretched face.
 */

/** The longest edge that survives. A 96px avatar on a 2x display needs 192. */
export const AVATAR_SIZE = 256;

/**
 * JPEG rather than PNG, and 0.85 rather than 1.0.
 *
 * A photograph as PNG is several times larger for no visible gain, and the
 * difference between 0.85 and maximum quality is invisible at 256px while
 * roughly halving the bytes.
 */
const QUALITY = 0.85;

/** What the server will accept. Kept in step with `AVATAR_TYPES` in UserService. */
export const AVATAR_MIME = "image/jpeg";

/** Refused before any decoding is attempted, so a wrong pick fails fast. */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export class AvatarError extends Error {}

/**
 * A file from the picker, as a square data URL ready to send.
 *
 * Rejects anything that is not one of the raster types above. SVG is excluded
 * deliberately: it can carry script, and it would run against whoever opened
 * the profile — the server refuses it too, and failing here just says so
 * sooner and in words.
 */
export async function avatarFromFile(file: Blob): Promise<string> {
  if (file.type && !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new AvatarError("Choose a PNG, JPEG or WebP image.");
  }
  const bitmap = await decode(file);
  return toSquareDataUrl(bitmap);
}

/**
 * Draw a source image square, centred and downscaled.
 *
 * Exported for the camera path, which already holds a video frame and has no
 * file to decode.
 */
export function toSquareDataUrl(
  source: CanvasImageSource,
  width: number,
  height: number,
): string;
export function toSquareDataUrl(source: ImageBitmap | HTMLImageElement): string;
export function toSquareDataUrl(
  source: CanvasImageSource,
  width?: number,
  height?: number,
): string {
  const w = width ?? (source as ImageBitmap).width;
  const h = height ?? (source as ImageBitmap).height;
  if (!w || !h) throw new AvatarError("That image could not be read.");

  // The largest centred square the source contains.
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AvatarError("This browser cannot process images.");
  ctx.drawImage(source, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL(AVATAR_MIME, QUALITY);
}

/**
 * `createImageBitmap` where it exists, an `<img>` where it does not.
 *
 * The fallback matters for Safari versions that have the function but refuse
 * some blobs, and the object URL is revoked either way so a rejected pick does
 * not leak the file.
 */
async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new AvatarError("That file is not an image Recallix can read."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Initials for somebody with no picture.
 *
 * First letters of the first and last words, so "Chaitanyasai Gandi" is CG
 * rather than CH. One word gives one letter; nothing gives a question mark,
 * which is honest about not knowing rather than showing a stray character from
 * an opaque user id.
 */
export function initialsOf(name?: string | null, fallback?: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const alt = (fallback ?? "").trim();
    return alt ? alt.slice(0, 2).toUpperCase() : "?";
  }
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
