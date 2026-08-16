"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Star,
  FolderOpen,
} from "lucide-react";
import {
  useGetProjectsQuery,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderDialog } from "@/components/folder-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { sortFolders, type FolderSort } from "@/lib/folders";
import { relativeDay } from "@/lib/days";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";

/**
 * Every folder, and nothing else.
 *
 * <p>A table rather than the tree this used to be. The tree expanded each folder
 * in place, which sounds helpful and meant the page could not answer the one
 * question a list of folders is for — which of these did I touch last — because
 * the answer was buried under whichever rows happened to be open.
 *
 * <p>What left with it: the Unfiled row. Home lists every meeting whether it is
 * filed or not, so unfiled work is not hidden by leaving it out; it was here
 * because this page was once the only meeting list there was.
 */
export default function FoldersPage() {
  const { data: folders, isLoading } = useGetProjectsQuery();
  const [sort, setSort] = React.useState<FolderSort>("updated");
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Project | null>(null);

  const rows = React.useMemo(() => sortFolders(folders ?? [], sort), [folders, sort]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setCreating(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New folder
        </Button>
      </div>

      <div>
        {/* The header is the sort control. Two columns, so a dropdown of two
            choices would be one more click than clicking the column itself. */}
        <div className="flex items-center justify-between gap-4 border-b px-1 pb-2 text-xs font-semibold text-muted-foreground">
          <SortButton label="Name" value="name" sort={sort} onSort={setSort} />
          <SortButton label="Last Updated" value="updated" sort={sort} onSort={setSort} />
        </div>

        {isLoading ? (
          <div className="space-y-3 py-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <FolderOpen className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">No folders yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              A folder groups meetings by the work they belong to — then you can
              ask questions of the whole folder at once.
            </p>
            <Button variant="outline" className="mt-4 gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New folder
            </Button>
          </div>
        ) : (
          <ul>
            {rows.map((folder) => (
              <FolderRow key={folder.id} folder={folder} onRename={() => setRenaming(folder)} />
            ))}
          </ul>
        )}
      </div>

      <FolderDialog open={creating} onOpenChange={setCreating} />
      <FolderDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        folder={renaming}
      />
    </div>
  );
}

function SortButton({
  label,
  value,
  sort,
  onSort,
}: {
  label: string;
  value: FolderSort;
  sort: FolderSort;
  onSort: (s: FolderSort) => void;
}) {
  const active = sort === value;
  return (
    <button
      type="button"
      onClick={() => onSort(value)}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 transition-colors hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {label}
      <span aria-hidden className={cn("text-[9px]", !active && "opacity-0")}>
        ▼
      </span>
    </button>
  );
}

function FolderRow({ folder, onRename }: { folder: Project; onRename: () => void }) {
  const [update] = useUpdateProjectMutation();
  const [remove, { isLoading: removing }] = useDeleteProjectMutation();

  async function onDelete() {
    // The meetings survive — `ON DELETE SET NULL`, and the service unfiles them
    // explicitly so it can say how many. Worth saying before, not only after:
    // the word "delete" over a folder full of recordings reads as worse than it
    // is, and somebody who believes it will keep folders they do not want.
    if (
      !window.confirm(
        `Delete “${folder.name}”? Its ${folder.meetingCount} meeting${
          folder.meetingCount === 1 ? "" : "s"
        } are kept — they move back to Unfiled.`,
      )
    ) {
      return;
    }
    try {
      const { unfiledMeetings } = await remove(folder.id).unwrap();
      toast.success(
        unfiledMeetings > 0
          ? `Folder deleted. ${unfiledMeetings} meeting${unfiledMeetings === 1 ? "" : "s"} moved to Unfiled.`
          : "Folder deleted.",
      );
    } catch {
      toast.error("Couldn't delete that folder.");
    }
  }

  return (
    <li className="group flex items-center gap-3 border-b px-1 py-3 transition-colors hover:bg-accent/40">
      <Link href={`/projects/${folder.id}`} className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {folder.favorite && (
            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />
          )}
          <span className="truncate font-semibold">{folder.name}</span>
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          {folder.meetingCount} conversation{folder.meetingCount === 1 ? "" : "s"}
        </span>
      </Link>

      <span className="shrink-0 text-sm text-muted-foreground">
        {relativeDay(folder.updatedAt)}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${folder.name}`}
            className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onSelect={() =>
              void update({ id: folder.id, body: { favorite: !folder.favorite } })
            }
          >
            <Star
              className={cn("mr-2 h-4 w-4", folder.favorite && "fill-amber-400 text-amber-400")}
            />
            {folder.favorite ? "Remove star" : "Star folder"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="mr-2 h-4 w-4" /> Rename Folder
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={removing}
            onSelect={(e) => {
              e.preventDefault();
              void onDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete Folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
