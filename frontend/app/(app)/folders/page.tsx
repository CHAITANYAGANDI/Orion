import { redirect } from "next/navigation";
import { LIBRARY } from "@/lib/routes";

/**
 * The folder list moved into Library.
 *
 * <p>A redirect rather than a deletion, because this URL is three years of
 * bookmarks, a link on the meeting menu that somebody may have open, and the
 * destination of a folder deletion in a tab that has not been reloaded. A 404
 * for any of those is a worse answer than the page they were going to.
 *
 * <p>It is also still where {@link isFolderListPath} points, which is what keeps
 * the band underlining Library on the way through.
 *
 * <p>The page itself is `components/folder-table.tsx`, which carries every test
 * this route had plus the three-state handling it was missing — see
 * `components/folder-table.test.tsx`.
 */
export default function FoldersPage() {
  redirect(LIBRARY);
}
