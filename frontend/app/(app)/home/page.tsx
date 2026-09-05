"use client";

/**
 * Now.
 *
 * <p>Where you are in the day, what needs a person, and what you have not filed
 * yet — with the chat and your own list in the margin beside it. That pairing is
 * the whole design: the dashboard this replaced led with usage bars and a plan
 * summary, which is information about the account rather than about the work,
 * and nobody opens a meeting recorder to find out how many minutes they have
 * left.
 *
 * <p>The list is grouped by day and the day is a heading, not a column, because
 * a meeting archive is read as a diary.
 *
 * <h2>The scope picker is gone, and the list it hid is a page now</h2>
 *
 * <p>There were two options: <i>Recent Conversations</i> (everything outside
 * your folders) and <i>All Conversations</i> (everything in this workspace).
 * They are not two filters. They are two questions — "what is happening" and
 * "what do I have" — and answering both with one screen is why this page needed
 * three different empty states to explain which of them you were looking at.
 *
 * <p>So <i>All</i> became <b>Library</b>, a place in the band, and this page is
 * <i>Recent</i> with no picker above it. Which makes the label under the
 * heading load-bearing rather than decorative: it is the only thing on screen
 * that explains why a meeting recorded ten minutes ago inside a folder is
 * missing from a list called Recent, and it is what connects that heading to
 * the "Everything is in a folder" empty state behind it. It used to be a hint
 * inside the picker's menu. <b>Do not drop it.</b>
 *
 * <p>The stored preference key is left where it is rather than cleared. Nothing
 * reads `home.scope.v2` any more, and clearing it would mean a write on load
 * from a page whose whole problem once was doing something surprising on load.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  ListChecks,
  ChevronDown,
  FileAudio,
  FolderOpen,
  Download,
  Mic,
  CalendarDays,
  RotateCw,
} from "lucide-react";
import { useGetMeetingsQuery, useGetPreferencesQuery, useGetProjectsQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationRow } from "@/components/conversation-row";
import { ActionItemsPanel } from "@/components/action-items-panel";
import {
  DateFilter,
  ANY_TIME,
  restoreWindow,
  type DateWindow,
} from "@/components/date-filter";
import { useStickyPreference, type PreferenceCodec } from "@/lib/preferences";
import { HomeChatPanel } from "@/components/home-chat-panel";
import { SidePane } from "@/components/side-pane";
import { isTerminal } from "@/lib/format";
import { groupByDay } from "@/lib/days";
import { homeListState } from "@/lib/home-list-state";
import type { MeetingResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LIBRARY, recordHref } from "@/lib/routes";

type Panel = "chat" | "actions";

const WHEN_CODEC: PreferenceCodec<DateWindow> = {
  // The choice, not the window. Storing the instants would pin "Last 7 days" to
  // the week it was picked and leave "Today" labelling a day that has passed.
  save: (value) => value.choice ?? null,
  load: (raw) => restoreWindow(raw),
};

export default function HomePage() {
  // The window is remembered until sign-out. This is a page people leave and
  // come back to constantly — open a meeting, come back, open another — and a
  // filter that reset on every return meant narrowing the list was work you did
  // once per visit rather than once. A new sign-in starts from the default; see
  // lib/preferences.ts for why a preference must never outlive its session.
  const whenPref = useStickyPreference<DateWindow>("home.when", ANY_TIME, WHEN_CODEC);
  const { value: when, set: setWhen } = whenPref;
  const [panel, setPanel] = React.useState<Panel>("chat");

  /**
   * Whether the remembered window has been read back yet.
   *
   * <p>It cannot be read while rendering, so the first render always holds the
   * default. Asking the server during that render would fetch everything and
   * then immediately fetch it again narrowed — two requests, and a list that
   * visibly changes under the reader. Waiting one tick costs the skeleton that
   * was going to be on screen anyway.
   */
  const restored = whenPref.ready;

  // Both narrowings go to the server rather than being applied to what came
  // back. This asks for fifty rows; dropping the filed ones from those would
  // answer "conversations outside a folder" with whichever of the fifty most
  // recent happened to be outside one, and would look right until somebody had
  // more than fifty meetings. The scope used to be applied here, over the page,
  // which is half of why it did nothing.
  const meetings = useGetMeetingsQuery(
    {
      page: 0,
      size: 50,
      from: when.from ?? undefined,
      to: when.to ?? undefined,
      // Fixed now that the picker is gone. The screen says Recent and the wire
      // says unfiled, and each is right where it is: the label is the product's
      // word for this list, the parameter is what the query actually does to
      // it. Everything, filed included, is Library — a page rather than a value
      // this line used to take.
      unfiled: true,
    },
    {
      skip: !restored,
      /*
       * Ask again every time Home is opened.
       *
       * A meeting's status is the one field in this list that changes without
       * anybody touching the list, and the cached copy is whatever was true
       * when it was last fetched. Arriving back on Home after a meeting
       * finished elsewhere would otherwise show it still "Processing" -- the
       * row's socket only carries *changes*, so subscribing after the fact
       * hears nothing at all.
       *
       * One request per visit, against a page of fifty rows. The docked
       * watcher covers meetings this tab started or opened; this covers the
       * rest, including one processed on another device.
       */
      refetchOnMountOrArgChange: true,
    },
  );
  // Derived from `data` rather than from a `?? []` above it: the fallback array
  // is a new value on every render, which would make the grouping below rerun
  // — and `new Date()` inside it produce different day boundaries — on renders
  // that have nothing to do with the data changing.
  const { data } = meetings;

  /*
   * Four states, decided in one place -- see lib/home-list-state.ts.
   *
   * `count` is `null` when there is no page cached, NOT 0. That distinction is
   * the bug: `data?.content ?? []` read "no answer yet" as "the answer is
   * none", so a failed request told people with hundreds of meetings that they
   * had none.
   */
  const listState = homeListState({
    restored,
    isUninitialized: meetings.isUninitialized,
    isLoading: meetings.isLoading,
    isFetching: meetings.isFetching,
    isError: meetings.isError,
    isSuccess: meetings.isSuccess,
    count: data ? data.content.length : null,
  });

  const groups = React.useMemo(() => groupByDay(data?.content ?? []), [data]);

  return (
    <>
      {/* The list, and nothing else. What used to be the second column of this
          page — the chat and the action items — is a pane of the shell, so it
          runs the full height of the window and this page does not state its
          width. See components/side-pane.tsx. */}
      <section className="scrollbar-none h-[calc(100vh-var(--band))] overflow-y-auto px-4 py-6 lg:px-6">
        <div className="mx-auto max-w-3xl">
          <Masthead meetings={data?.content} />

          <div className="mb-3 mt-8 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-title-3 font-headline text-ink">Recent</h2>
              {/* LOAD-BEARING. It is the only thing on screen that explains
                  why a meeting recorded ten minutes ago inside a folder is not
                  in a list called Recent, and it is what connects this heading
                  to the "Everything is in a folder" screen behind it. It was
                  the hint inside the scope picker's menu; the picker is gone
                  and this is now the whole of the explanation. */}
              <p className="mt-0.5 text-foot text-ink-3">
                Everything outside your folders. The rest is in{" "}
                <Link href={LIBRARY} className="underline underline-offset-2 hover:text-ink-2">
                  Library
                </Link>
                .
              </p>
            </div>
            {/* The one question the list cannot answer about itself. */}
            <DateFilter value={when} onChange={setWhen} />
          </div>

          {listState === "skeleton" ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : listState === "error" ? (
            <HomeLoadError onRetry={() => void meetings.refetch()} />
          ) : listState === "empty" ? (
            <EmptyState
              when={when}
              onClearDate={() => setWhen(ANY_TIME)}
              onRetry={() => void meetings.refetch()}
            />
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-6">
                <h3 className="v2-label mb-2">{group.label}</h3>
                <ul className="space-y-2">
                  {group.items.map((meeting) => (
                    <ConversationRow key={meeting.id} meeting={meeting} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </section>

      <SidePane>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b px-2">
            <PanelTab
              icon={<Sparkles className="h-4 w-4" />}
              label="AI Chat"
              active={panel === "chat"}
              onClick={() => setPanel("chat")}
            />
            <PanelTab
              icon={<ListChecks className="h-4 w-4" />}
              label="Action Items"
              active={panel === "actions"}
              onClick={() => setPanel("actions")}
            />
          </div>
          <div className="min-h-0 flex-1">
            {/* Both stay mounted: switching to the tasks and back should not
                throw away a half-typed question or re-run the chat's history
                fetch. Hidden rather than unmounted. */}
            <div className={cn("h-full", panel === "chat" ? "block" : "hidden")}>
              <HomeChatPanel />
            </div>
            <div className={cn("h-full", panel === "actions" ? "block" : "hidden")}>
              <ActionItemsPanel />
            </div>
          </div>
        </div>
      </SidePane>
    </>
  );
}

/* ------------------------------- the masthead ------------------------------ */

/**
 * Where you are in the day, and whether anything needs a person.
 *
 * <h2>What is NOT here, and why</h2>
 *
 * <p>The V2 concept put a "Needs you" block at the top of this page, built from
 * cross-meeting memory — decisions that had moved, risks open N days, promises
 * that had slipped twice. None of that exists: the migrations dropped
 * `meeting_decisions`, `decision_links`, `commitments` and
 * `commitment_evidence`, and nothing has replaced them. See
 * docs/v2-implementation/feature-parity.md §2.
 *
 * <p>The parity matrix proposed remapping it to action items —
 * `{ mine: true, status: "OPEN" }`, overdue first. That was written before the
 * two things that make it dishonest here:
 *
 * <ul>
 *   <li><b>`mine` is matched against the display name in Settings</b>, which is
 *       empty until somebody sets one. A tally reading "0 open" for an account
 *       with a dozen open items is worse than no tally.</li>
 *   <li><b>The panel in the margin is standalone items only</b> — what somebody
 *       typed for themselves. A workspace-wide count above a list of three rows
 *       is a number that contradicts the thing under it, and standalone items
 *       carry no due date, so an "overdue" figure would be a permanent zero.</li>
 * </ul>
 *
 * <p>So what is here instead is derived from the page's own list, costs no
 * request, and cannot be wrong: how many conversations are still being made,
 * and how many could not be. A failed transcription is the one thing on this
 * screen that genuinely needs a human, and it was previously findable only by
 * scrolling for a red badge.
 */
function Masthead({ meetings }: { meetings?: MeetingResponse[] }) {
  const { mode, userId, profile } = useAuth();
  const prefs = useGetPreferencesQuery();

  /*
   * The clock is read after mounting, never during a render.
   *
   * This page is prerendered as static content, so a greeting computed while
   * rendering would be baked at BUILD time — "Good evening" at nine in the
   * morning, for everybody, until the next deploy — and would mismatch on
   * hydration into the bargain. `null` until the browser has a clock, and the
   * two lines hold their height so nothing under them moves when it arrives.
   */
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => setNow(new Date()), []);

  // The same order of precedence as the account menu: what this person typed
  // into Settings, then what they told their identity provider, then nothing.
  // Never the user id -- an opaque key in the place a name goes reads as
  // somebody else's account, which is exactly how it was reported.
  const full = prefs.data?.displayName?.trim() || profile.name || (mode === "dev" ? userId : "");
  // First name only. "Good morning, Chaitanyasai Gandi" is a form letter.
  const first = full.trim().split(/\s+/)[0] || null;

  const hour = now?.getHours() ?? 0;
  const greeting =
    hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // From the list already on screen. `undefined` means it has not arrived, and
  // nothing is claimed until it has.
  const making = meetings?.filter((m) => !isTerminal(m.status)).length ?? 0;
  const failed = meetings?.filter((m) => m.status === "FAILED").length ?? 0;

  return (
    <header>
      {/* Both lines reserve their height, so the greeting arriving one tick
          after the list does not push the list down under a reader's cursor. */}
      <p className="v2-label h-4">
        {now
          ? now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })
          : ""}
      </p>
      <h1 className="mt-1 h-9 text-title-l font-headline text-ink">
        {now ? (first ? `${greeting}, ${first}` : greeting) : ""}
      </h1>

      {(failed > 0 || making > 0) && (
        <p className="mt-2 space-x-1.5 text-body">
          {/* Two sentences rather than one clause-joined one. A failed
              transcription and a job still running are different amounts of
              your problem, and the reader should be able to stop after the
              first. No link on either: both are rows in the list four
              centimetres below, carrying the stage and the percentage. */}
          {failed > 0 && (
            <span className="text-danger">
              {failed === 1
                ? "One conversation could not be transcribed."
                : `${failed} conversations could not be transcribed.`}
            </span>
          )}
          {making > 0 && (
            <span className="text-ink-2">
              {making === 1
                ? "One conversation is still being made."
                : `${making} conversations are still being made.`}
            </span>
          )}
        </p>
      )}
    </header>
  );
}

/* -------------------------------- the list -------------------------------- */

/**
 * The list could not be fetched, and we are not going to pretend otherwise.
 *
 * <p>This is the screen that was missing. Without it a failed request fell
 * through to "No conversations — Record / Import", which tells somebody with a
 * full archive that it is empty and offers to help them start their first
 * meeting. The two readings are opposites and only one of them is recoverable
 * by waiting.
 *
 * <p>No status code, no message from the server, no URL. The cause is in the
 * network tab for whoever wants it; on the page it would be noise at best, and
 * at worst it leaks the shape of the backend to a screen anybody can reach.
 *
 * <p>`role="alert"` because this replaces content the reader was waiting for --
 * somebody who has already moved on would otherwise never learn it did not
 * arrive.
 */
function HomeLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center"
    >
      <RotateCw className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">Couldn&apos;t load your conversations</p>
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
 * Nothing to show, and why.
 *
 * <p>A filter that empties the list has to say so, and offer the way back.
 * Without it the page offers Record and Import to somebody with a hundred
 * meetings, which reads as an archive that lost them rather than as a filter
 * doing its job — and the way out is a control they have to remember they
 * touched.
 *
 * <p>Two things can do it. The date window is checked first because it is the
 * likelier cause and the one somebody has just used; the filing is checked
 * second, and it is the one most likely to be misread, since a folder is
 * exactly where a meeting goes when it stops appearing where you left it.
 *
 * <p>Which makes one question worth a request of its own: an empty Recent means
 * either that everything is filed or that there is nothing at all, and those
 * two want opposite screens — the way to Library, or the way to a first
 * recording. One row is enough to tell them apart, and it is only ever asked
 * for when there is nothing to show.
 *
 * <p><b>The probe is not optional.</b> This list is narrowed by default and
 * always has been, so an account that had filed everything opened Home to
 * nothing and was told "No conversations" with an offer to help with a first
 * recording — the archive-lost screen, over a full archive, reached by doing
 * nothing at all. That is the common path rather than a corner, which is
 * exactly why this exists.
 *
 * <p>What changed when the scope picker became a page: the way out is a
 * navigation rather than a control somebody has to remember they never touched.
 * The `scope !== "recent"` guard that used to skip the probe is gone with the
 * other scope, because there is only one list here now.
 */
function EmptyState({
  when,
  onClearDate,
  onRetry,
}: {
  when: DateWindow;
  onClearDate: () => void;
  /** Fetch the list again, for the one state below that cannot explain itself. */
  onRetry: () => void;
}) {
  const { userId } = useAuth();
  const filtered = when.from !== null || when.to !== null;

  // Skipped unless it is the question being asked. `size: 1` because the count
  // is the whole answer.
  const workspace = useGetMeetingsQuery({ page: 0, size: 1 }, { skip: filtered });
  /*
   * The same truthfulness rule as the main list, on the probe behind it.
   *
   * `workspace.data?.totalElements ?? 0` would read a FAILED probe as "the
   * workspace contains zero meetings" -- which is the screen that says the
   * account is empty and offers a first recording. A request that never
   * answered proves nothing, so `null` is kept distinct from `0` here too.
   */
  const total = workspace.isSuccess && workspace.data ? workspace.data.totalElements : null;

  /*
   * The folders, because "everything is in a folder" is a claim about them.
   *
   * <p>Usually already in the cache — Library and the import dialog both ask
   * for it — so this is a cache read rather than a request on most arrivals.
   * Three-state for the same reason
   * everything else on this screen is -- a folder list that has not arrived is
   * not a folder list with nothing in it.
   */
  const folders = useGetProjectsQuery();
  const folderCount = folders.isSuccess && folders.data ? folders.data.length : null;

  /*
   * The message below says these meetings are in folders. It may only say so
   * when there are folders for them to be in.
   *
   * <p>Production produced the screen this guards against: "Everything is in a
   * folder" over a sidebar with no folders in it. Those two cannot both be
   * true, and the app had every fact needed to know that and said it anyway --
   * the same failure as an empty state over a failed request, one level up. An
   * empty state explains itself, and an explanation that contradicts the rest
   * of the screen is worse than no explanation at all.
   */
  const filedElsewhere = total !== null && total > 0 && folderCount !== null && folderCount > 0;

  /**
   * The workspace has meetings, this list has none, and there is no folder that
   * could be holding them.
   *
   * <p>Nothing about that is a state the product has: with no folders, "outside
   * your folders" and "everything" are the same list, so one of these two
   * answers is wrong. Which one is not knowable from here, so this claims
   * neither -- it says the list could not be shown and offers the two things
   * that recover it.
   */
  const unexplained = !filtered && total !== null && total > 0 && folderCount === 0;
  /**
   * The probe was asked and did not answer, so neither screen below is known.
   *
   * <p>Keyed off `total` rather than off `isSuccess`, so the one expression
   * decides it. `isSuccess` with no body is not a state RTK Query produces, but
   * splitting the question across two lines is how the pair drifts apart -- and
   * the drift would land on the screen that tells somebody their account is
   * empty.
   */
  const probeUnresolved = !filtered && (total === null || folderCount === null);

  if (filtered) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <CalendarDays className="h-8 w-8 text-muted-foreground" />
        {/* "from" rather than "in", and the label verbatim: it reads correctly
            for all three shapes the window can take — "from Today", "from Last
            7 days", "from Thu, 13 Aug" — where lower-casing turns a date into
            "thu, 13 aug". */}
        <p className="mt-3 font-medium">Nothing from {when.label}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          There are no conversations in this stretch of time. Your other meetings
          are still here.
        </p>
        <Button variant="outline" className="mt-4" onClick={onClearDate}>
          Show any time
        </Button>
      </div>
    );
  }

  // Nothing rather than a guess, for the moment between the two answers. It is
  // one row over a warm connection, and a sentence that turns out to be wrong
  // is worse than a blank half-second.
  if (workspace.isLoading || workspace.isFetching || folders.isLoading || folders.isFetching) {
    return null;
  }

  /*
   * The probe failed. Both screens below make a claim it was supposed to
   * settle -- "everything is filed" or "you have nothing" -- and neither is
   * known now, so this says only what is certainly true: this list is empty,
   * and the wider list is one click away. It never tells somebody their
   * account is empty on the strength of a request that failed.
   */
  if (probeUnresolved) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">Nothing outside your folders</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This list leaves out anything filed into a folder. Your other
          conversations may be in one.
        </p>
        <LibraryButton />
      </div>
    );
  }

  /*
   * The workspace has meetings and there is no folder that could be holding
   * them, so one of the two answers is wrong and this claims neither.
   *
   * <p>It is a distinct screen rather than a fallback because the two things it
   * offers are different: try the request again, and go and look at the whole
   * list. Telling somebody their account is empty here would be the worst
   * available reading of a state where we know it is not.
   */
  if (unexplained) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center"
      >
        <RotateCw className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">Couldn&apos;t show your conversations</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This list is the conversations outside your folders, and there are no
          folders — so it should be showing all of them. Your conversations are
          still here.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href={LIBRARY}>Go to Library</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (filedElsewhere) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">Everything is in a folder</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          A conversation recorded or imported inside a folder is filed there.
          Nothing has been lost — this list is the ones that were not.
        </p>
        <LibraryButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <FileAudio className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">No conversations</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Record a meeting from your browser, or bring in a file you already have.
        {userId ? "" : ""}
      </p>
      <div className="mt-4 flex gap-2">
        <Button asChild>
          <Link href={recordHref("/home")}>
            <Mic className="mr-2 h-4 w-4" /> Record
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/upload">
            <Download className="mr-2 h-4 w-4" /> Import
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The way to the whole list.
 *
 * <p>A link, not a button that flips a filter. That is the substance of the
 * change: "Show all conversations" used to set a scope on this page, so the way
 * out of an empty list was a control somebody had to remember they had never
 * touched. Library is a place in the band, reachable whether or not this screen
 * ever appeared.
 */
function LibraryButton() {
  return (
    <Button variant="outline" className="mt-4" asChild>
      <Link href={LIBRARY}>Go to Library</Link>
    </Button>
  );
}

function PanelTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
