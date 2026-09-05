"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus, MoreHorizontal, Pencil, Trash2, Star, FolderOpen } from "lucide-react";
import {
  useGetProjectsQuery,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FolderDialog } from "@/components/folder-dialog";
import { ResourceLoadError } from "@/components/resource-load-error";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { sortFolders, type FolderSort } from "@/lib/folders";
import { relativeDay } from "@/lib/days";
import { presenceOfList, resourceState } from "@/lib/resource-state";
import { cn } from "@/lib/utils";
import { folderHref } from "@/lib/routes";
import type { Project } from "@/lib/types";

/**
 * Every folder, at the top of Library.
 *
 * <p>A table rather than the tree this used to be. The tree expanded each folder
 * in place, which sounds helpful and meant the page could not answer the one
 * question a list of folders is for — which of these did I touch last — because
 * the answer was buried under whichever rows happened to be open.
 *
 * <p>What left with it: the row for meetings in no folder. Home lists those, and
 * the conversations underneath this list are everything, so nothing is hidden by
 * leaving them out; the row was here because this page was once the only meeting
 * list there was.
 *
 * <h2>Where this came from, and the bug it arrived with</h2>
 *
 * <p>This was `/folders`, its own page, reached from a section in the navigation
 * rail. Both are gone — folders are part of what you have, so they are part of
 * Library, and `/folders` redirects here.
 *
 * <p>The rail section it replaced (`FolderTree`) had one thing this page did not
 * and it is carried over rather than lost. That component decided what to draw
 * with `projects ?? []`, was fixed, and this page still had the bug: an
 * unresolved request, a first load, a dropped connection and a 500 all arrived
 * as a list of length zero and drew "No folders yet" — the same confident
 * sentence about somebody's account, produced by a failure to reach the server.
 *
 * <p>So the state of the query is decided first, by {@link resourceState}, and
 * only then is anything turned into a list. Four outcomes: cached folders beat
 * a refetch and beat a refetch that failed; a failure with nothing behind it
 * says so and offers a retry; anything unresolved is a skeleton; and only a
 * settled, successful, genuinely empty answer draws the empty state.
 *
 * <p><b>No `absent` case.</b> `GET /projects` answers an account with no folders
 * with `[]`, so a 404 from it means the route is missing from the deployed
 * build — a fault to report, not zero folders.
 */
export function FolderTable() {
  const projects = useGetProjectsQuery();
  const [sort, setSort] = React.useState<FolderSort>("updated");
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Project | null>(null);

  const state = resourceState({
    isUninitialized: projects.isUninitialized,
    isLoading: projects.isLoading,
    isFetching: projects.isFetching,
    isError: projects.isError,
    isSuccess: projects.isSuccess,
    /*
     * `presenceOfList`, not `data?.length ?? 0`. An undefined body is
     * "unknown", which is a skeleton; only an array that arrived with nothing
     * in it is "none", which is the empty state. Collapsing those two is the
     * whole of the bug above.
     */
    content: presenceOfList(projects.data),
  });

  const rows = React.useMemo(
    () => sortFolders(projects.data ?? [], sort),
    [projects.data, sort],
  );

  return (
    <section>
      {/* The button is on the page, beside the list it acts on.

          It used to be in the top bar, which was the right place while the bar
          was per-page. The bar is a global band now and carries nothing that
          belongs to the page underneath, so New folder up there would be
          offering one page's action from every screen in the app.

          The empty state below keeps its own. A button in the middle of an
          explanation of what folders are for is the one somebody reading that
          explanation will press. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-title-3 font-headline text-ink">Folders</h2>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New folder
        </Button>
      </div>

      {/* The header is the sort control. Two columns, so a dropdown of two
          choices would be one more click than clicking the column itself. */}
      {state !== "error" && (
        <div className="flex items-center justify-between gap-4 border-b px-1 pb-2 text-xs font-semibold text-muted-foreground">
          <SortButton label="Name" value="name" sort={sort} onSort={setSort} />
          <SortButton label="Last Updated" value="updated" sort={sort} onSort={setSort} />
        </div>
      )}

      {state === "loading" ? (
        <div className="space-y-3 py-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : state === "error" ? (
        <ResourceLoadError
          title="Couldn't load your folders"
          detail="Your folders are still here. Something went wrong fetching them."
          onRetry={() => void projects.refetch()}
          retrying={projects.isFetching}
        />
      ) : state === "empty" ? (
        <div className="py-12 text-center">
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

      <FolderDialog open={creating} onOpenChange={setCreating} />
      <FolderDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        folder={renaming}
      />
    </section>
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
        } are kept — they move out of the folder.`,
      )
    ) {
      return;
    }
    try {
      const { unfiledMeetings } = await remove(folder.id).unwrap();
      toast.success(
        unfiledMeetings > 0
          ? `Folder deleted. ${unfiledMeetings} meeting${unfiledMeetings === 1 ? "" : "s"} moved out of it.`
          : "Folder deleted.",
      );
    } catch {
      toast.error("Couldn't delete that folder.");
    }
  }

  return (
    <li className="group flex items-center gap-3 border-b px-1 py-3 transition-colors hover:bg-accent/40">
      <Link href={folderHref(folder.id)} className="min-w-0 flex-1">
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
