"use client";

/**
 * Rename and delete, for the folder currently open.
 *
 * <p>In the top bar rather than on the page, beside Record. Those are the three
 * things you do to a folder you are standing in, and having two of them at the
 * top of the document while the third sat in the header meant looking in two
 * places for one set of actions.
 *
 * <p>It reads the folder from the route rather than being handed one, because
 * the shell renders the header and does not know what page it is wrapping.
 * `useGetProjectQuery` is the same call the page underneath already made, so
 * this is a cache read; if it misses — a hard refresh, where both mount at
 * once — RTK Query collapses the two into one request.
 *
 * <p>Renders nothing until the folder resolves. A menu offering to delete
 * something unnamed is worse than a menu that arrives a moment late, and the
 * confirmation below is only meaningful once there is a name to put in it.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Trash2, Search as SearchIcon } from "lucide-react";
import { useGetProjectQuery, useDeleteProjectMutation } from "@/lib/api";
import { FolderDialog } from "@/components/folder-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export function FolderHeaderActions({ folderId }: { folderId: string }) {
  const router = useRouter();
  const { data: folder } = useGetProjectQuery(folderId);
  const [remove, { isLoading: removing }] = useDeleteProjectMutation();
  const [renaming, setRenaming] = React.useState(false);

  if (!folder) return null;

  async function onDelete() {
    if (!folder) return;
    // The meetings survive — ON DELETE SET NULL, and the service unfiles them
    // explicitly so it can say how many. Worth saying before rather than after:
    // "delete" over a folder full of recordings reads as worse than it is, and
    // somebody who believes it keeps folders they do not want.
    if (
      !window.confirm(
        `Delete “${folder.name}”? Its meetings are kept — they move back to Unfiled.`,
      )
    ) {
      return;
    }
    try {
      const { unfiledMeetings } = await remove(folderId).unwrap();
      toast.success(
        unfiledMeetings > 0
          ? `Folder deleted. ${unfiledMeetings} meeting${unfiledMeetings === 1 ? "" : "s"} moved to Unfiled.`
          : "Folder deleted.",
      );
      // The page behind this is now a folder that does not exist.
      router.push("/projects");
    } catch {
      toast.error("Couldn't delete that folder.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* `title` as well as `aria-label`: this is an unlabelled icon sitting
              between two labelled buttons, so hovering has to say what it is.
              It opens on click rather than on hover — a menu that opens by
              passing over it fires on the way to Record, and cannot be reached
              by a keyboard or a finger at all. */}
          <button
            type="button"
            aria-label="More options"
            title="More options"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="mr-2 h-4 w-4" /> Rename folder
          </DropdownMenuItem>
          {/* Kept from the menu this replaces. The folder as a search filter —
              the same grouping applied to decisions and transcripts rather than
              to meetings — and this is the only place it is offered. */}
          <DropdownMenuItem asChild>
            <Link href={`/search?project=${folderId}`}>
              <SearchIcon className="mr-2 h-4 w-4" /> Search in folder
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={removing}
            onSelect={(e) => {
              e.preventDefault();
              void onDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FolderDialog open={renaming} onOpenChange={setRenaming} folder={folder} />
    </>
  );
}
