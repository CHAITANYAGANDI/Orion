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
 * <p><b>Neither page filters by folder.</b> Home used to send `unfiled=true`
 * and this page never did, which made that parameter the seam between them —
 * and made Home's name a lie, since filing a meeting took it off a page called
 * Recent. It is gone from both. What separates them now is <em>how much they
 * show</em>: Home asks for the newest twenty, this asks for fifty and pages.
 * A difference in quantity is one a person can see; a hidden predicate is not.
 *
 * <p>Both still assert on the request rather than on the rows, because a
 * Library that ever inherited that flag would look completely right until
 * somebody opened a folder and found meetings the "everything" list had never
 * shown them.
 *
 * <h2>Folders live here</h2>
 *
 * <p>They were `/folders`, reached from a section in the navigation rail. Both
 * are gone. A folder is a way of grouping what you have, so it belongs on the
 * page called what you have — and with the rail gone, a separate route for them
 * would be a destination with no entrance. `/folders` redirects here, so old
 * links and bookmarks land somewhere sensible.
 *
 * <p>Folders above conversations, and not in a sidebar beside them. A folder is
 * a smaller, slower-moving list that people scan first and then leave; the
 * archive underneath is what they scroll. Putting the folders in a column would
 * take width from the only thing on this page that needs it.
 */

import * as React from "react";
import { RotateCw } from "lucide-react";
import { useGetMeetingsQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationRow } from "@/components/conversation-row";
import { FolderTable } from "@/components/folder-table";
import {
  DateFilter,
  ANY_TIME,
  restoreWindow,
  type DateWindow,
} from "@/components/date-filter";
import { useStickyPreference, type PreferenceCodec } from "@/lib/preferences";
import { groupByDay } from "@/lib/days";
import { homeListState } from "@/lib/home-list-state";

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

      <FolderTable />

      <h2 className="mb-3 mt-10 text-title-3 font-headline text-ink">Conversations</h2>

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
