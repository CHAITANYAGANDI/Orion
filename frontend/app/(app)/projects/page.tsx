"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  FolderOpen,
  Folder,
  Plus,
  ChevronRight,
  Sparkles,
  Inbox,
  Loader2,
} from "lucide-react";
import {
  useGetProjectsQuery,
  useGetProjectMeetingsQuery,
  useGetUnfiledMeetingsQuery,
  useCreateProjectMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MeetingResponse, Project } from "@/lib/types";

/**
 * Projects.
 *
 * <p>The tree is the point: a project is only useful if you can see what is in
 * it without leaving the list. Each row expands in place, and the meetings load
 * when it opens rather than up front — a workspace with twenty projects would
 * otherwise make twenty requests to render a page where nineteen of them are
 * collapsed.
 *
 * <p>Unfiled meetings are shown at the bottom rather than hidden. A grouping
 * feature that makes ungrouped things harder to find has taken more than it
 * gave, and this is also the list somebody works through the first time they
 * create a project.
 */
export default function ProjectsPage() {
  const { data: projects, isLoading } = useGetProjectsQuery();
  const [create, { isLoading: creating }] = useCreateProjectMutation();
  const [name, setName] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || creating) return;
    try {
      const project = await create({ name: clean }).unwrap();
      setName("");
      // Open what was just made: an empty project that stays collapsed looks
      // like nothing happened.
      setOpen(project.id);
    } catch (err) {
      const message =
        typeof err === "object" && err && "data" in err
          ? ((err as { data?: { message?: string } }).data?.message ?? "")
          : "";
      toast.error(message || "Couldn't create that project.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Group meetings by the work they belong to — then ask questions of the
          whole project at once.
        </p>
      </div>

      <form onSubmit={onCreate} className="flex max-w-md gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project — e.g. Client ABC"
          aria-label="New project name"
          maxLength={120}
        />
        <Button type="submit" disabled={!name.trim() || creating} className="gap-1.5">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create
        </Button>
      </form>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {(projects ?? []).map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              open={open === p.id}
              onToggle={() => setOpen(open === p.id ? null : p.id)}
            />
          ))}

          {(projects ?? []).length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No projects yet. Create one above, then file meetings into it from
                the meeting page or from the list below.
              </CardContent>
            </Card>
          )}

          <UnfiledRow open={open === "__unfiled"} onToggle={() => setOpen(open === "__unfiled" ? null : "__unfiled")} />
        </div>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  open,
  onToggle,
}: {
  project: Project;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {open ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium">{project.name}</span>
            {project.description && (
              <span className="block truncate text-xs text-muted-foreground">
                {project.description}
              </span>
            )}
          </span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {project.meetingCount}
          </span>
        </button>

        <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1.5">
          <Link href={`/projects/${project.id}`}>
            <Sparkles className="h-3.5 w-3.5" />
            Open
          </Link>
        </Button>
      </div>

      {open && <ProjectMeetings projectId={project.id} />}
    </Card>
  );
}

/** Loaded only once the row is open — see the page comment. */
function ProjectMeetings({ projectId }: { projectId: string }) {
  const { data, isLoading } = useGetProjectMeetingsQuery(projectId);

  if (isLoading) {
    return (
      <div className="space-y-2 border-t px-4 py-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  return (
    <MeetingBranch
      meetings={data ?? []}
      empty="Nothing filed here yet. File a meeting from its page, or when you upload it."
    />
  );
}

function UnfiledRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data, isLoading } = useGetUnfiledMeetingsQuery(undefined, { skip: !open });
  // The count comes with the list, so a collapsed row cannot show one without
  // fetching everything it is meant to be deferring.
  return (
    <Card className="border-dashed">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} unfiled meetings`}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Unfiled</span>
          <span className="block text-xs text-muted-foreground">
            Meetings that do not belong to a project yet
          </span>
        </span>
        {open && data && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {data.length}
          </span>
        )}
      </button>

      {open &&
        (isLoading ? (
          <div className="space-y-2 border-t px-4 py-3">
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <MeetingBranch meetings={data ?? []} empty="Everything is filed." />
        ))}
    </Card>
  );
}

function MeetingBranch({
  meetings,
  empty,
}: {
  meetings: MeetingResponse[];
  empty: string;
}) {
  if (meetings.length === 0) {
    return <p className="border-t px-4 py-4 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="border-t">
      {meetings.map((m) => (
        <li key={m.id} className="border-b last:border-0">
          <Link
            href={`/meetings/${m.id}`}
            className="flex items-center justify-between gap-3 py-2 pl-11 pr-4 transition-colors hover:bg-accent/50"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm">{m.title}</span>
              <span className="block text-xs text-muted-foreground">
                {formatDateTime(m.createdAt)}
              </span>
            </span>
            <StatusBadge status={m.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
