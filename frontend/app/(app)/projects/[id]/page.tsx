"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Sparkles,
  ArrowLeft,
  Trash2,
  Pencil,
  Check,
  X,
  Search as SearchIcon,
} from "lucide-react";
import {
  useGetProjectQuery,
  useGetProjectMeetingsQuery,
  useGetProjectChatQuery,
  useGetProjectConversationsQuery,
  useAskProjectChatMutation,
  useCreateProjectConversationMutation,
  useClearProjectChatMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useRenameConversationMutation,
  useDeleteConversationMutation,
  useDeleteChatExchangeMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { ScopedChat } from "@/components/scoped-chat";
import { PROJECT_PROMPTS } from "@/lib/chat-prompts";
import { formatDateTime, formatDuration } from "@/lib/format";

/**
 * One project: what is in it, and a chat that can only see what is in it.
 *
 * <p>The chat is the reason the grouping exists. A meeting chat answers about
 * one conversation and the workspace chat answers about everything, and neither
 * is the question people actually have — "where does the ABC work stand" is a
 * question about a body of work over weeks, which is exactly what a project is.
 *
 * <p>Both halves are on one screen rather than behind tabs. Reading the answer
 * and seeing which meetings could have produced it is the same act; separating
 * them would mean clicking back and forth to check whether an answer covers
 * what you think it covers.
 */
export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const { data: project, isLoading } = useGetProjectQuery(id);
  const { data: meetings } = useGetProjectMeetingsQuery(id);

  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const {
    data: messages,
    isLoading: chatLoading,
    isError: chatError,
  } = useGetProjectChatQuery(conversationId ? { id, conversationId } : { id });
  const { data: conversations } = useGetProjectConversationsQuery(id);

  const [ask, { isLoading: asking }] = useAskProjectChatMutation();
  const [newConversation, { isLoading: starting }] = useCreateProjectConversationMutation();
  const [clear, { isLoading: clearing }] = useClearProjectChatMutation();
  const [rename] = useRenameConversationMutation();
  const [removeConversation] = useDeleteConversationMutation();
  const [deleteExchange, { isLoading: deleting }] = useDeleteChatExchangeMutation();
  const [remove, { isLoading: removing }] = useDeleteProjectMutation();

  const scope = `PRJ-${id}`;

  // Same two recoveries as the workspace chat: follow the thread the server
  // filed the turn under, and drop a thread id that no longer resolves.
  React.useEffect(() => {
    if (!conversationId && messages && messages.length > 0) {
      setConversationId(messages[0].conversationId);
    }
  }, [messages, conversationId]);

  React.useEffect(() => {
    if (chatError && conversationId) setConversationId(null);
  }, [chatError, conversationId]);

  async function send(question: string) {
    try {
      const answer = await ask({ id, question, conversationId: conversationId ?? undefined }).unwrap();
      setConversationId(answer.conversationId);
    } catch {
      toast.error("Couldn't get an answer.");
    }
  }

  async function onDeleteProject() {
    if (
      !window.confirm(
        `Delete “${project?.name}”? Its meetings are kept — they move back to Unfiled.`,
      )
    ) {
      return;
    }
    try {
      const { unfiledMeetings } = await remove(id).unwrap();
      toast.success(
        unfiledMeetings > 0
          ? `Project deleted. ${unfiledMeetings} meeting${unfiledMeetings === 1 ? "" : "s"} moved to Unfiled.`
          : "Project deleted.",
      );
      router.push("/projects");
    } catch {
      toast.error("Couldn't delete that project.");
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          That project no longer exists.{" "}
          <Link href="/projects" className="underline">
            Back to projects
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Projects
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <ProjectHeading project={project} />
        <div className="flex shrink-0 gap-2">
          {/* The project as a search filter — the same grouping, applied to
              decisions, commitments and transcripts rather than meetings. */}
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href={`/search?project=${project.id}`}>
              <SearchIcon className="h-3.5 w-3.5" /> Search in project
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDeleteProject}
            disabled={removing}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            Meetings{" "}
            <span className="font-normal text-muted-foreground">
              {project.meetingCount}
            </span>
          </h2>
          <Card>
            <CardContent className="p-0">
              {(meetings ?? []).length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nothing filed here yet. Open a meeting and choose this project,
                  or pick it when you upload.
                </p>
              ) : (
                <ul>
                  {(meetings ?? []).map((m) => (
                    <li key={m.id} className="border-b last:border-0">
                      <Link
                        href={`/meetings/${m.id}`}
                        className="flex items-center justify-between gap-2 px-4 py-2.5 transition-colors hover:bg-accent/50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{m.title}</span>
                          <span className="block text-xs text-muted-foreground">
                            {formatDateTime(m.createdAt)} · {formatDuration(m.durationSeconds)}
                          </span>
                        </span>
                        <StatusBadge status={m.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-primary" /> Ask Recallix about this project
              </h2>
              <p className="text-xs text-muted-foreground">
                Answers are grounded in these {project.meetingCount} meeting
                {project.meetingCount === 1 ? "" : "s"} and nothing else.
              </p>
            </div>
            {(conversations?.length ?? 0) > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={clearing}
                onClick={async () => {
                  if (!window.confirm("Delete every conversation about this project?")) return;
                  try {
                    await clear(id).unwrap();
                    setConversationId(null);
                  } catch {
                    toast.error("Couldn't clear the conversation.");
                  }
                }}
                className="shrink-0 gap-1.5 text-xs text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear all
              </Button>
            )}
          </div>

          <ScopedChat
            messages={messages}
            conversations={conversations ?? []}
            conversationId={conversationId}
            onSelectConversation={setConversationId}
            loading={chatLoading}
            asking={asking}
            deleting={deleting}
            starting={starting}
            prompts={PROJECT_PROMPTS}
            emptyLine={`Ask a question about “${project.name}”.`}
            thinkingLine="Reading this project's meetings…"
            placeholder={`Ask about ${project.name}…`}
            onSend={send}
            onNewConversation={async () => {
              try {
                const created = await newConversation(id).unwrap();
                setConversationId(created.id);
              } catch {
                toast.error("Couldn't start a new chat.");
              }
            }}
            onRename={async (cid, title) => {
              await rename({ conversationId: cid, title, scope }).unwrap();
            }}
            onDeleteConversation={async (cid) => {
              await removeConversation({ conversationId: cid, scope }).unwrap();
              if (cid === conversationId) setConversationId(null);
            }}
            onDeleteExchange={async (messageId) => {
              const result = await deleteExchange({ messageId, scope }).unwrap();
              if (result.conversationDeleted) setConversationId(null);
            }}
          />
        </section>
      </div>
    </div>
  );
}

/** The name, renameable in place — the same pattern as the meeting title. */
function ProjectHeading({ project }: { project: { id: string; name: string; description: string } }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description);
  const [save, { isLoading: saving }] = useUpdateProjectMutation();

  React.useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project.name, project.description]);

  async function commit() {
    const clean = name.trim();
    if (!clean) {
      setName(project.name);
      setEditing(false);
      return;
    }
    try {
      await save({ id: project.id, body: { name: clean, description } }).unwrap();
      setEditing(false);
    } catch (err) {
      const message =
        typeof err === "object" && err && "data" in err
          ? ((err as { data?: { message?: string } }).data?.message ?? "")
          : "";
      toast.error(message || "Couldn't rename that project.");
    }
  }

  if (!editing) {
    return (
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <span className="truncate">{project.name}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Rename project"
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-4 w-4" />
          </button>
        </h1>
        {project.description && (
          <p className="text-sm text-muted-foreground">{project.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Project name"
        maxLength={120}
        className="max-w-xs"
      />
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Project description"
        placeholder="What is this project?"
        maxLength={500}
        className="max-w-sm"
      />
      <div className="flex gap-1">
        <Button size="icon" variant="ghost" onClick={commit} disabled={saving} aria-label="Save">
          <Check className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            setName(project.name);
            setDescription(project.description);
            setEditing(false);
          }}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
