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
 * section whose only entry is an instruction, and /projects has the room to
 * explain what a folder is for.
 *
 * Nothing navigates after a folder is made. The new folder appearing in the rail
 * is the confirmation, and being thrown into an empty page in the middle of
 * whatever you were doing is not an improvement on that.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Plus } from "lucide-react";
import { useGetProjectsQuery } from "@/lib/api";
import { FolderDialog } from "@/components/folder-dialog";
import { cn } from "@/lib/utils";

export function FolderTree({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const { data: projects } = useGetProjectsQuery();
  const [open, setOpen] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const folders = projects ?? [];

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
          href="/projects"
          onClick={onNavigate}
          className={cn(
            "flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-foreground",
            pathname === "/projects" ? "text-foreground" : "text-muted-foreground",
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
          {folders.map((folder) => {
            const active = pathname === `/projects/${folder.id}`;
            return (
              <Link
                key={folder.id}
                href={`/projects/${folder.id}`}
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
              that has room for it. /projects carries the empty state and the
              New folder button, which is where the heading leads. */}
        </div>
      )}

      <FolderDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
