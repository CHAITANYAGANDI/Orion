"use client";

/**
 * Folders — what used to be called Projects.
 *
 * Collapsible, because the rail is shared with the places you go and a long
 * folder list should not be able to push them off the screen. The plus lives on
 * the section heading and appears on hover: creating is not something you do
 * often enough to deserve permanent chrome, but it has to be where the folders
 * are rather than three clicks away on another page.
 *
 * <p>The heading is a link and the chevron is the toggle. They used to be one
 * control that only collapsed, which left "show me everything" to a row at the
 * foot of the list called "All folders" — so seeing every folder meant opening
 * a list of folders and then scrolling past them to a link. The word Folders
 * now goes to the folder list, which is the obvious thing for it to do.
 *
 * <p>The section holds folders and nothing else. It no longer offers to create
 * one when the list is empty; an empty rail section is a smaller lie than a
 * section whose only entry is an instruction, and /folders has the room to
 * explain what a folder is for.
 *
 * Nothing navigates after a folder is made. The new folder appearing in the rail
 * is the confirmation, and being thrown into an empty page in the middle of
 * whatever you were doing is not an improvement on that.
 *
 * <h2>Why this section is no longer allowed to simply be blank</h2>
 *
 * <p>It decided what to draw with <code>projects ?? []</code>, which is the bug
 * the rest of the app spent a pass removing: it reads <em>no answer</em> as
 * <em>the answer is none</em>. An unresolved request, a first load, a dropped
 * connection and a 500 all arrived here as a list of length zero and were drawn
 * exactly like an account with no folders — a blank FOLDERS section, with no
 * skeleton to say wait and no way to try again. In production that is the whole
 * sidebar going quietly missing until somebody thinks to refresh.
 *
 * <p>So the state of the query is decided first, by {@link resourceState}, and
 * only then is anything turned into a list. The four outcomes are the same four
 * as everywhere else in Orion: cached folders beat a refetch and beat a refetch
 * that failed; a failure with nothing behind it says so and offers a retry;
 * anything unresolved is a skeleton; and only a settled, successful, genuinely
 * empty answer draws the empty section.
 *
 * <p><b>No <code>absent</code> flag.</b> <code>GET /projects</code> answers an
 * account with no folders with <code>[]</code>, so a 404 from it means the
 * route is missing from the deployed build — a fault to report, not zero
 * folders.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Folder, Plus, RotateCw } from "lucide-react";
import { useGetProjectsQuery } from "@/lib/api";
import { FolderDialog } from "@/components/folder-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { presenceOfList, resourceState } from "@/lib/resource-state";
import { cn } from "@/lib/utils";
import { FOLDERS, folderHref } from "@/lib/routes";

export function FolderTree({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const projects = useGetProjectsQuery();
  const [open, setOpen] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const state = resourceState({
    isUninitialized: projects.isUninitialized,
    isLoading: projects.isLoading,
    isFetching: projects.isFetching,
    isError: projects.isError,
    isSuccess: projects.isSuccess,
    /*
     * `presenceOfList`, not `data?.length ?? 0`. An undefined body is
     * "unknown", which is a skeleton; only an array that arrived with nothing
     * in it is "none", which is the empty section. Collapsing those two is the
     * whole of the bug this file is fixing.
     */
    content: presenceOfList(projects.data),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-4">
      {/* `group` so the plus can key off a hover of the whole heading row —
          hovering a 14px target to reveal a second one is a game rather than
          an affordance. */}
      <div className="group flex items-center gap-1 pr-1">
        {/* The chevron and the word are two controls, not one.
            The heading used to toggle the list, and the way to see every folder
            at once was a row at the bottom of that list called "All folders" —
            so the answer to "show me my folders" was to open a list of folders
            and then click past all of them. The word is the link now, and the
            chevron keeps the collapse. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse folders" : "Expand folders"}
          className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <Link
          href={FOLDERS}
          onClick={onNavigate}
          className={cn(
            "flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-foreground",
            pathname === FOLDERS ? "text-foreground" : "text-muted-foreground",
          )}
        >
          Folders
        </Link>

        {/* Invisible until hovered, but always in the DOM and focusable, so it
            is reachable by keyboard and readable by a screen reader — a control
            that only exists for a mouse is one half the users cannot press. */}
        <button
          type="button"
          aria-label="Create a folder"
          title="Create a folder"
          onClick={() => {
            setOpen(true);
            setCreating(true);
          }}
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {state === "loading" && <FolderTreeSkeleton />}

          {state === "error" && (
            <FolderLoadError
              onRetry={() => {
                void projects.refetch();
              }}
              retrying={projects.isFetching}
            />
          )}

          {/* `projects.data` rather than a list prepared above: reaching "ready"
              already means a body arrived with something in it, and there is no
              `?? []` anywhere on the way here to make that a guess. */}
          {state === "ready" &&
            projects.data?.map((folder) => {
              const active = pathname === folderHref(folder.id);
              return (
                <Link
                  key={folder.id}
                  href={folderHref(folder.id)}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{folder.name}</span>
                </Link>
              );
            })}

          {/* Folders and nothing else.
              No "All folders" row — the heading above goes there. And no
              "create your first folder" row when the list is empty: this
              section is a list of what exists, and teaching belongs on the page
              that has room for it. /folders carries the empty state and the
              New folder button, which is where the heading leads.

              Which is only defensible now that "empty" means the server said
              so. It used to mean that, and also four other things. */}
        </div>
      )}

      <FolderDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/**
 * Three grey rows while the folders are on their way.
 *
 * <p>Roughly the shape of what is about to arrive, so the rail does not jump
 * when it does — and named for a screen reader, because otherwise the section
 * is silent for exactly as long as it is uncertain.
 */
function FolderTreeSkeleton() {
  return (
    <div className="space-y-2 px-3 py-2" aria-busy="true">
      <span className="sr-only">Loading folders</span>
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3.5 w-3/5" />
    </div>
  );
}

/**
 * The folders could not be fetched, said in the width of a sidebar.
 *
 * <h2>Why not ResourceLoadError</h2>
 *
 * <p>Same rule, different room. That one is a dashed card with a centred icon
 * and forty pixels of padding, sized to replace a panel in the middle of a
 * page; dropped into a 16rem rail it becomes the loudest thing on the screen,
 * and it would be shouting about a section most people are not looking at. Two
 * lines and a text button is the whole of what is wanted here: what failed, and
 * the way to try it again.
 *
 * <p>`role="alert"` because it replaces content the reader was waiting for.
 * Everything else about it is deliberately quiet.
 */
function FolderLoadError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="px-3 py-2">
      <p className="text-sm text-muted-foreground">Couldn&apos;t load folders</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-1 inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary transition-colors hover:underline disabled:opacity-60"
      >
        <RotateCw className="h-3 w-3" /> Try again
      </button>
    </div>
  );
}
