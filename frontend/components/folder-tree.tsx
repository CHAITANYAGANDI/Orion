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
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 px-1 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Folders
        </button>

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
          {/* With nothing filed yet, the plus is invisible until hovered and
              "All folders" leads to an empty page — so the empty state does the
              teaching instead. */}
          {folders.length === 0 ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              Create your first folder
            </button>
          ) : (
            <Link
              href="/projects"
              onClick={onNavigate}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              All folders
            </Link>
          )}
        </div>
      )}

      <FolderDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
