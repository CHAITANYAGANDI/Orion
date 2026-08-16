"use client";

/**
 * Naming a folder — a new one, or an existing one being renamed.
 *
 * One dialog for both because they are the same form and the same two failures.
 * The rail is a list of what exists rather than a place to make more, so the
 * plus that opens this appears on hover: present when you are looking at the
 * folders and out of the way when you are not. A dialog rather than an inline
 * row because the rail is narrow enough that an input in it would truncate the
 * name being typed.
 *
 * The failure worth designing for is the name that is refused — a duplicate is
 * the common one, and the server checks it before the unique index does. The
 * dialog stays open and keeps what was typed; closing it on error would throw
 * away the one thing the person contributed.
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useCreateProjectMutation, useUpdateProjectMutation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Project } from "@/lib/types";

/** Matches the column on `projects.name`. */
const MAX_NAME = 120;

export function FolderDialog({
  open,
  onOpenChange,
  folder,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present for a rename; absent to create. */
  folder?: Pick<Project, "id" | "name"> | null;
  onCreated?: (folder: Project) => void;
}) {
  const [create, { isLoading: creating }] = useCreateProjectMutation();
  const [update, { isLoading: renaming }] = useUpdateProjectMutation();
  const [name, setName] = React.useState(folder?.name ?? "");
  const busy = creating || renaming;

  // Re-seeded when the dialog is pointed at a different folder — the rename
  // menu on a list of ten rows reuses one dialog for all of them.
  React.useEffect(() => {
    if (open) setName(folder?.name ?? "");
  }, [open, folder?.id, folder?.name]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    try {
      if (folder) {
        await update({ id: folder.id, body: { name: clean } }).unwrap();
      } else {
        const made = await create({ name: clean }).unwrap();
        onCreated?.(made);
      }
      setName("");
      onOpenChange(false);
    } catch (err) {
      const message =
        typeof err === "object" && err && "data" in err
          ? ((err as { data?: { message?: string } }).data?.message ?? "")
          : "";
      // Left open on purpose: whatever was typed is still in the box.
      toast.error(message || (folder ? "Couldn't rename that folder." : "Couldn't create that folder."));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setName("");
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{folder ? "Rename folder" : "Create a folder"}</DialogTitle>
          <DialogDescription>
            Group meetings by the work they belong to — then ask questions of the
            whole folder at once.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="folder-name" className="text-sm font-medium">
              Enter a name for this folder
            </label>
            <Input
              id="folder-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled"
              maxLength={MAX_NAME}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            {/* Disabled until there is a name: a folder called "" is a row
                nobody can tell apart from the next one. */}
            <Button type="submit" disabled={!name.trim() || busy} className="gap-1.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {folder ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
