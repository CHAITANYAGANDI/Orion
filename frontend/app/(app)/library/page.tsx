"use client";

/**
 * Library — everything you have.
 *
 * <h2>Why this is a page and not a filter</h2>
 *
 * <p>"All Conversations" was an option in a dropdown on Home, next to "Recent
 * Conversations", and the difference between them is not a filter — it is the
 * difference between <em>what is happening</em> and <em>what I have</em>. Home
 * is the first: the meetings that have not been filed anywhere, newest first,
 * with the chat and the action items beside them. This is the second, and it is
 * the one people arrive at with a specific thing in mind.
 *
 * <p>Putting it behind a picker had two costs. It was invisible — a list you
 * reach by remembering a control you have never pressed — and it made Home
 * answer two questions with one screen, which is why that screen needed three
 * different empty states to explain which of the two you were looking at.
 *
 * <p><b>Home keeps its picker for now.</b> Relocating the scope is Home's own
 * rebuild, not this one, and shipping a Library while Home still offers the
 * same list is a duplicate for one phase rather than a page with nothing in it.
 * See docs/v2-implementation/feature-parity.md §4.
 *
 * <h2>Folders live here too, and are still at their own URL</h2>
 *
 * <p>The navigation rail that used to hold the folder tree is gone, so this is
 * now the way to them. For this phase that is a link to the folder list rather
 * than the list itself; the two pages merge when Library is rebuilt around the
 * measure. Nothing about the folders themselves changes.
 */

import * as React from "react";
import Link from "next/link";
import { FolderOpen, RotateCw } from "lucide-react";
import { useGetMeetingsQuery, useGetProjectsQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationRow } from "@/components/conversation-row";
import {
  DateFilter,
  ANY_TIME,
  restoreWindow,
  type DateWindow,
} from "@/components/date-filter";
import { useStickyPreference, type PreferenceCodec } from "@/lib/preferences";
import { groupByDay } from "@/lib/days";
import { homeListState } from "@/lib/home-list-state";
import { FOLDERS } from "@/lib/routes";

/** The choice, not the window. See the identical codec on Home for why. */
const WHEN_CODEC: PreferenceCodec<DateWindow> = {
  save: (value) => value.choice ?? null,
  load: (raw) => restoreWindow(raw),
};

export default function LibraryPage() {
  // Its own key, not Home's. The two lists are read for different reasons —
  // Home is a glance at this week, this is a search of the archive — and a
  // window narrowed on one of them has no business narrowing the other.
  const whenPref = useStickyPreference<DateWindow>("library.when", ANY_TIME, WHEN_CODEC);
  const { value: when, set: setWhen } = whenPref;

  const meetings = useGetMeetingsQuery(
    {
      page: 0,
      size: 50,
      from: when.from ?? undefined,
      to: when.to ?? undefined,
      // No `unfiled`. That parameter is what makes Home's list "everything
      // outside your folders"; this list is everything, which is the whole
      // distinction between the two pages.
    },
    {
      // The remembered window cannot be read while rendering, so the first
      // render always holds ANY_TIME. Asking then would fetch the archive and
      // immediately fetch it again narrowed.
      skip: !whenPref.ready,
      // A meeting's status changes without anybody touching the list, and the
      // cached copy is whatever was true when it was last fetched.
      refetchOnMountOrArgChange: true,
    },
  );
  const { data } = meetings;

  const state = homeListState({
    restored: whenPref.ready,
    isUninitialized: meetings.isUninitialized,
    isLoading: meetings.isLoading,
    isFetching: meetings.isFetching,
    isError: meetings.isError,
    isSuccess: meetings.isSuccess,
    // `null` when there is no page cached, NOT 0. `data?.content ?? []` reads
    // "no answer yet" as "the answer is none", which tells somebody with a
    // hundred meetings that they have none.
    count: data ? data.content.length : null,
  });

  const groups = React.useMemo(() => groupByDay(data?.content ?? []), [data]);

  return (
    <div className="pb-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title-1 font-headline text-ink">Library</h1>
        <DateFilter value={when} onChange={setWhen} />
      </div>

      <FoldersLink />

      <h2 className="v2-label mb-3 mt-7">Conversations</h2>

      {state === "skeleton" ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : state === "error" ? (
        <LibraryLoadError onRetry={() => void meetings.refetch()} />
      ) : state === "empty" ? (
        <EmptyLibrary when={when} onClearDate={() => setWhen(ANY_TIME)} />
      ) : (
        groups.map((group) => (
          <div key={group.key} className="mb-6">
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">{group.label}</h3>
            <ul className="space-y-2">
              {group.items.map((meeting) => (
                <ConversationRow key={meeting.id} meeting={meeting} />
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The way to the folders, now that the rail is not.
 *
 * <p>It states the count rather than only naming the destination, because the
 * question somebody has on this page is whether their folders are worth opening
 * — and a row that says "3 folders" answers it without a navigation.
 *
 * <p>Three-state, like everything else that reads a list here: a folder count
 * that has not arrived is not a folder count of zero. An unresolved query gets
 * the name and no number rather than a confident "0 folders", which is the
 * claim that sends somebody looking for folders they still have.
 */
function FoldersLink() {
  const folders = useGetProjectsQuery();
  const count = folders.isSuccess && folders.data ? folders.data.length : null;

  return (
    <Link
      href={FOLDERS}
      className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <FolderOpen className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">Folders</span>
        <span className="block text-xs text-muted-foreground">
          {count === null
            ? "The work you have grouped together"
            : count === 0
              ? "Nothing grouped yet"
              : `${count} folder${count === 1 ? "" : "s"}`}
        </span>
      </span>
    </Link>
  );
}

/**
 * The archive could not be fetched, and we are not going to pretend otherwise.
 *
 * <p>Without this a failed request falls through to an empty state, which tells
 * somebody with a full archive that it is empty. The two readings are opposites
 * and only one of them is recoverable by waiting. `role="alert"` because this
 * replaces content the reader was waiting for.
 */
function LibraryLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center"
    >
      <RotateCw className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">Couldn&apos;t load your library</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Your conversations are still here. Something went wrong fetching them.
      </p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Nothing to show, and which of the two reasons it is.
 *
 * <p>Only two here, where Home has four. This list has no scope to have hidden
 * anything — it is everything — so the date window is the only filter that can
 * empty it, and the other case is an account with nothing in it yet. Home needs
 * a probe and three screens precisely because its list is narrowed by default.
 */
function EmptyLibrary({ when, onClearDate }: { when: DateWindow; onClearDate: () => void }) {
  if (when.from !== null || when.to !== null) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <p className="font-medium">Nothing from {when.label}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          There are no conversations in this stretch of time. The rest of your
          library is still here.
        </p>
        <Button variant="outline" className="mt-4" onClick={onClearDate}>
          Show any time
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <p className="font-medium">Nothing here yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Record a meeting or import a file you already have, and it will be here.
        Record and Import are at the top of every page.
      </p>
    </div>
  );
}
