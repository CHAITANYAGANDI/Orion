"use client";

/**
 * Home.
 *
 * Your conversations on the left, and on the right the two things you do with
 * them: ask a question about them, or look at what they committed you to. That
 * pairing is the whole design — the old dashboard led with usage bars and a plan
 * summary, which is information about the account rather than about the work,
 * and nobody opens a meeting recorder to find out how many minutes they have
 * left.
 *
 * The list is grouped by day and the day is a heading, not a column, because a
 * meeting archive is read as a diary. The scope picker above it answers the one
 * question the list cannot: whether this is everything in the workspace, or
 * only what was never filed into a folder.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  ListChecks,
  ChevronDown,
  FileAudio,
  FolderOpen,
  Youtube,
  FileText,
  Download,
  Mic,
  CalendarDays,
  RotateCw,
} from "lucide-react";
import { useGetMeetingsQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { ProcessingRow, useLiveMeetingStatus } from "@/components/processing-row";
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
import { formatDuration, isTerminal } from "@/lib/format";
import { groupByDay } from "@/lib/days";
import { homeListState } from "@/lib/home-list-state";
import type { MeetingResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { recordHref } from "@/lib/routes";

/**
 * Which conversations to list.
 *
 * <p>Two, and they differ. There were three: "For you" took the twenty most
 * recent and called them unread, which they were not — nothing tracks whether a
 * meeting has been read — and "My Conversations" and "All Conversations"
 * returned the same rows as each other, because one account per workspace means
 * every meeting is yours. A picker whose options produce identical lists is
 * worse than no picker: it is read as a filter that is broken.
 *
 * <p>What is left is the distinction that does exist now that recordings and
 * imports file themselves into the folder they were started in — whether this
 * is the whole workspace, or only what was never filed into one.
 *
 * <p><strong>Recent Conversations is about folders, not about time.</strong>
 * Both options are newest-first and both sit inside the same date window, so
 * the label is doing no work that "All" is not; what separates them is
 * `unfiled=true` on the wire — whether a meeting was ever put in a folder.
 *
 * <p>Which makes <b>the hint load-bearing</b>, not decoration. It is the only
 * thing on screen that explains why a meeting recorded ten minutes ago inside a
 * folder is missing from a list called Recent, and it is what connects the
 * label to the "Everything is in a folder" empty state behind it. Renaming the
 * option to "Unfiled Conversations" would carry that in the label instead;
 * that was tried and reverted, and "Recent" is the product's word for this
 * list. So the hint is the whole of the explanation. Do not drop it.
 *
 * <p>The hints are written as a pair, and read as one: everything outside your
 * folders, or everything in this workspace. Said that way round they describe
 * two lists, rather than one list and one property a meeting either has or does
 * not.
 *
 * <p>Otter offers "Shared with me" as well, and Orion cannot: nobody can
 * share anything *into* a one-account workspace. Offering the row anyway would
 * be a filter that is permanently empty and reads as a fault.
 */
const SCOPES = [
  { value: "recent", label: "Recent Conversations", hint: "everything outside your folders" },
  { value: "all", label: "All Conversations", hint: "everything in this workspace" },
] as const;

/*
 * The order here is the order in the menu, and it is NOT the default.
 *
 * Recent is listed first and Home still opens on All -- see DEFAULT_SCOPE
 * below, and SCOPE_PREF_KEY for why opening on Recent was a bug worth a
 * version bump. The two are easy to conflate because a picker usually leads
 * with the option it is on; anyone tempted to "tidy" this by making the first
 * entry the default should read that note first.
 */

type Scope = (typeof SCOPES)[number]["value"];

type Panel = "chat" | "actions";

/**
 * Both filters are remembered until you sign out. See lib/preferences.ts.
 *
 * <p>Defined out here rather than inline because the hook depends on them: a
 * codec rebuilt on every render would re-read storage on every render, and put
 * back the value you had just changed.
 */
const SCOPE_CODEC: PreferenceCodec<Scope> = {
  save: (value) => value,
  load: (raw) => (raw === "recent" || raw === "all" ? raw : null),
};

/**
 * Home shows the whole workspace unless somebody says otherwise.
 *
 * <h2>The bug</h2>
 *
 * <p>This defaulted to `recent`, and `recent` means `unfiled=true` on the wire
 * -- conversations that were never put in a folder. So the default Home was not
 * "your meetings", it was "your meetings, minus the ones you organised". An
 * account that had tidied everything away opened Home to "Everything is in a
 * folder" and a button, with no meetings visible anywhere.
 *
 * <p>Being remembered made it stick. The scope is persisted, so once `recent`
 * was written down -- which happened the first time anybody touched the picker,
 * and the default was already `recent` besides -- every later visit restored it.
 * Opening a meeting and coming back landed on the empty state again.
 *
 * <h2>Why a new key rather than a new default</h2>
 *
 * <p>Changing the default alone would fix nothing for anyone already using the
 * app: their browser has `home.scope: "recent"` in localStorage, and a restored
 * value beats a default every time. The bug would survive the deployment in
 * exactly the browsers that hit it.
 *
 * <p>And the stored value cannot be repaired in place, because it is ambiguous.
 * Under v1 the default *was* `recent`, so a stored `"recent"` means either "I
 * chose this" or "I touched the picker once and it wrote down where I already
 * was" -- and nothing distinguishes them. Honouring it keeps the bug; dropping
 * it silently discards a real preference for the few who meant it.
 *
 * <p>A version bump resolves that by not pretending to know: v1 is abandoned
 * wholesale, everyone starts on `all`, and the first explicit choice under v2 is
 * unambiguous because the default it differs from is now the safe one. One
 * preference lost once, for the minority who had set it deliberately, against a
 * broken first screen for everybody who had not.
 *
 * <p>The old `home.scope` entry is left where it is rather than deleted. It is
 * inert -- nothing reads that name any more -- and clearing it would mean a
 * write on load, from a page whose whole problem was doing something surprising
 * on load.
 */
const SCOPE_PREF_KEY = "home.scope.v2";

/**
 * All Conversations, and only an explicit choice moves off it.
 *
 * <p>Recent stays in the picker: filing is real, and "what I have not filed
 * yet" is a genuine question. It is just not the question Home should answer
 * before being asked -- a list that hides rows by default has to be chosen, not
 * arrived at.
 */
const DEFAULT_SCOPE: Scope = "all";

const WHEN_CODEC: PreferenceCodec<DateWindow> = {
  // The choice, not the window. Storing the instants would pin "Last 7 days" to
  // the week it was picked and leave "Today" labelling a day that has passed.
  save: (value) => value.choice ?? null,
  load: (raw) => restoreWindow(raw),
};

export default function HomePage() {
  // Home opens on Recent: what has not been filed anywhere else. A meeting
  // recorded inside a folder is therefore not on this list until you switch to
  // All — deliberately, because the folder is where it was put and the rail on
  // the left is how you get back to it.
  //
  // Home counts the whole workspace now. It used to open on Recent, where the
  // count excluded anything filed -- see SCOPE_PREF_KEY for why that default
  // was wrong and why the key is versioned.
  // Both of these are remembered until sign-out. Home is a page people leave
  // and come back to constantly — open a meeting, come back, open another — and
  // a filter that reset on every return meant narrowing the list was work you
  // did once per visit rather than once.
  const scopePref = useStickyPreference<Scope>(SCOPE_PREF_KEY, DEFAULT_SCOPE, SCOPE_CODEC);
  const whenPref = useStickyPreference<DateWindow>("home.when", ANY_TIME, WHEN_CODEC);
  const { value: scope, set: setScope } = scopePref;
  const { value: when, set: setWhen } = whenPref;
  const [panel, setPanel] = React.useState<Panel>("chat");

  /**
   * Whether the remembered filters have been read back yet.
   *
   * <p>They cannot be read while rendering, so the first render always holds
   * the defaults. Asking the server during that render would fetch the whole
   * workspace and then immediately fetch it again narrowed — two requests, and
   * a list that visibly changes under the reader. Waiting one tick costs the
   * skeleton that was going to be on screen anyway.
   */
  const restored = scopePref.ready && whenPref.ready;

  // Both filters go to the server rather than narrowing what came back. This
  // asks for fifty rows; dropping the filed ones from those would answer
  // "conversations outside a folder" with whichever of the fifty most recent
  // happened to be outside one, and would look right until somebody had more
  // than fifty meetings. The scope used to be applied here, over the page,
  // which is half of why it did nothing.
  const meetings = useGetMeetingsQuery(
    {
      page: 0,
      size: 50,
      from: when.from ?? undefined,
      to: when.to ?? undefined,
      // The screen says Recent and the wire says unfiled, and each is right
      // where it is: the label is the product's word for this list, the
      // parameter is what the query actually does to it. One seam, here.
      unfiled: scope === "recent",
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
          page — the chat and the action items — is now a pane of the shell, so
          it runs the full height of the window rather than starting under the
          top bar, and this page no longer states its width. See
          components/side-pane.tsx. */}
      <section className="scrollbar-none h-[calc(100vh-4rem)] overflow-y-auto px-4 py-4 lg:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-center justify-between gap-3">
            {/* When on the left, whose on the right — the two questions the
                list itself cannot answer, in the order people ask them. */}
            <DateFilter value={when} onChange={setWhen} />
            {/* The button that hid the panel used to sit here. It is in the
                top bar now, next to the rest of the controls that act on the
                window rather than on the list, and it works at every width
                instead of only on a phone. */}
            <ScopePicker value={scope} onChange={setScope} />
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
              scope={scope}
              when={when}
              onClearDate={() => setWhen(ANY_TIME)}
              onShowAll={() => setScope("all")}
            />
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-6">
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                  {group.label}
                </h2>
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

/* -------------------------------- the list -------------------------------- */

/**
 * Narrow the list to a scope.
 *
 * "For you" is the recent slice rather than a different query: a workspace with
 * one account has no notion of relevance beyond recency, and inventing a ranking
 * would be a claim the data cannot support. "Mine" and "All" are identical today
 * for the same reason, and are kept apart because the distinction becomes real
 * the moment a workspace has two people in it — at which point this is the one
 * place that has to change.
 */
function ScopePicker({
  value,
  onChange,
}: {
  value: Scope;
  onChange: (scope: Scope) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = SCOPES.find((s) => s.value === value) ?? SCOPES[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        {current.label}
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="menu"
          // Anchored to the button's right edge, not its left. This trigger
          // sits at the right edge of the content column, so a menu growing
          // rightward from `left-0` ran ~120px past it — and the scroll
          // container it lives in cannot clip one axis without clipping the
          // other, so `overflow-y-auto` quietly became `overflow: auto`. The
          // hint text was cut off mid-word and the whole list grew a
          // horizontal scrollbar to reach a menu nobody wanted to scroll to.
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border bg-popover shadow-lg"
        >
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitemradio"
              aria-checked={s.value === value}
              onClick={() => {
                onChange(s.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                s.value === value && "bg-accent/60",
              )}
            >
              <span>
                <span className="block">{s.label}</span>
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              </span>
              {s.value === value && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One meeting in the list — and, while it is being made, how far along it is.
 *
 * <p>The processing row is the *same* row, not a separate section and not a
 * card of its own: a meeting has one place in this list and keeps it from the
 * moment it is saved. What is added is a status pill, the stage, a slim bar and
 * a percentage, plus a warning-tinted border so it is findable among nine
 * finished meetings without being a different kind of object. See
 * components/processing-row.
 *
 * <p>Clicking it opens the normal meeting route, exactly as a finished one does.
 */
function ConversationRow({ meeting }: { meeting: MeetingResponse }) {
  const Icon =
    meeting.sourceType === "YOUTUBE"
      ? Youtube
      : meeting.sourceType === "DOCUMENT"
        ? FileText
        : FileAudio;

  // Live, because Home does not poll its list. Terminal meetings open no
  // subscription -- see the hook.
  const { status, reported } = useLiveMeetingStatus(meeting.id, meeting.status);
  const processing = !isTerminal(status);

  return (
    <li>
      <Link
        href={`/meetings/${meeting.id}`}
        className={cn(
          "flex gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/40",
          // Slightly more prominent, still plainly one of the rows around it.
          processing && "border-warning/40 bg-warning/5",
        )}
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{meeting.title}</span>
            {/* One word while it runs. The stage is said in full underneath,
                and a pill that changed from "Transcribing" to "Summarizing"
                would be a second, competing statement of the same thing. */}
            {processing ? (
              <Badge variant="warning">Processing</Badge>
            ) : (
              status !== "READY" && <StatusBadge status={status} />
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {new Date(meeting.createdAt).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
            {meeting.durationSeconds ? ` · ${formatDuration(meeting.durationSeconds)}` : ""}
            {meeting.tags.length > 0 ? ` · ${meeting.tags.slice(0, 3).join(", ")}` : ""}
          </span>
          {processing && (
            <ProcessingRow meetingId={meeting.id} status={status} reported={reported} />
          )}
        </span>
      </Link>
    </li>
  );
}

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
 * <p>Two filters can do it now. The date window is checked first because it is
 * the likelier cause and the one somebody has just used; the scope is checked
 * second, and it is the one most likely to be misread, since a folder is
 * exactly where a meeting goes when it stops appearing where you left it.
 *
 * <p>Which makes one question worth a request of its own: an empty Recent means
 * either that everything is filed or that there is nothing at all, and those
 * two want opposite screens — the way to the folders, or the way to a first
 * recording. One row is enough to tell them apart, and it is only ever asked
 * for when there is nothing to show.
 *
 * <p><b>Only when Recent was chosen.</b> "Everything is in a folder" describes
 * a list that is hiding rows, which is only true of Recent — and Home no longer
 * opens there. On All Conversations an empty list means the workspace is empty,
 * full stop, so the probe below is skipped and the first-recording screen is
 * what shows. That skip is the whole guard: get it wrong and a new account is
 * told its meetings are filed somewhere, and handed a button to another empty
 * list.
 */
function EmptyState({
  scope,
  when,
  onClearDate,
  onShowAll,
}: {
  scope: Scope;
  when: DateWindow;
  onClearDate: () => void;
  onShowAll: () => void;
}) {
  const { userId } = useAuth();
  const filtered = when.from !== null || when.to !== null;

  // Skipped unless it is the question being asked. `size: 1` because the count
  // is the whole answer.
  const workspace = useGetMeetingsQuery(
    { page: 0, size: 1 },
    { skip: scope !== "recent" || filtered },
  );
  /*
   * The same truthfulness rule as the main list, on the probe behind it.
   *
   * `workspace.data?.totalElements ?? 0` would read a FAILED probe as "the
   * workspace contains zero meetings" -- which is the screen that says the
   * account is empty and offers a first recording. A request that never
   * answered proves nothing, so `null` is kept distinct from `0` here too.
   */
  const total = workspace.isSuccess && workspace.data ? workspace.data.totalElements : null;
  const filedElsewhere = total !== null && total > 0;
  /**
   * The probe was asked and did not answer, so neither screen below is known.
   *
   * <p>Keyed off `total` rather than off `isSuccess`, so the one expression
   * decides it. `isSuccess` with no body is not a state RTK Query produces, but
   * splitting the question across two lines is how the pair drifts apart -- and
   * the drift would land on the screen that tells somebody their account is
   * empty.
   */
  const probeUnresolved = scope === "recent" && !filtered && total === null;

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
  if (scope === "recent" && (workspace.isLoading || workspace.isFetching)) return null;

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
        <Button variant="outline" className="mt-4" onClick={onShowAll}>
          Show all conversations
        </Button>
      </div>
    );
  }

  /*
   * `scope === "recent"` as well as the count, though the probe above is
   * already skipped on any other scope so `filedElsewhere` cannot be true here.
   * Stated anyway: this screen must appear only when the user has explicitly
   * narrowed to the unfiled list, and tying that to one `skip` expression makes
   * it true by accident. Two lines apart, either could be relaxed without the
   * other being noticed.
   */
  if (scope === "recent" && filedElsewhere) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">Everything is in a folder</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          A conversation recorded or imported inside a folder is filed there.
          Nothing has been lost — this list is the ones that were not.
        </p>
        <Button variant="outline" className="mt-4" onClick={onShowAll}>
          Show all conversations
        </Button>
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
