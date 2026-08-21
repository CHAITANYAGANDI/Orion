"use client";

import * as React from "react";
import { Folder } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGetProjectsQuery } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Choosing which project something belongs to.
 *
 * <p>Used in two places that mean slightly different things — filing a meeting
 * that already exists, and filing one as it is uploaded — so it is a controlled
 * select and the caller decides what saving means.
 *
 * <p>"No folder" is always an option, never a placeholder. A picker whose empty
 * state is a greyed-out prompt can be got into but not out of: once a meeting
 * has a project there would be no way to say it should not.
 */
const NO_FOLDER = "__none";

export function ProjectPicker({
  value,
  onChange,
  disabled,
  className,
  label = "Project",
}: {
  value: string | null | undefined;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const { data: projects } = useGetProjectsQuery();

  // Nothing to file into yet. Rendering an empty dropdown would advertise a
  // feature and then refuse to do it; the Projects page is where it starts.
  if (!projects || projects.length === 0) return null;

  return (
    <Select
      value={value ?? NO_FOLDER}
      disabled={disabled}
      onValueChange={(v) => onChange(v === NO_FOLDER ? null : v)}
    >
      <SelectTrigger
        aria-label={label}
        className={cn("h-8 w-auto gap-1.5 px-2.5 text-xs", className)}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_FOLDER}>No folder</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
