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
  Download,
  Mic,
  CalendarDays,
  RotateCw,
} from "lucide-react";
import { useGetMeetingsQuery, useGetProjectsQuery } from "@/lib/api";
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
import { groupByDay } from "@/lib/days";
import { homeListState } from "@/lib/home-list-state";
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
 * <p>Otter offers "Shared with me" as well, and Reverie cannot: nobody can
 * share anything *into* a one-account workspace. Offering the row anyway would
 * be a filter that is permanently empty and reads as a fault.
 */
const SCOPES = [
  { value: "recent", label: "Recent Conversations", hint: "everything outside your folders" },
  { value: "all", label: "All Conversations", hint: "everything in this workspace" },
] as const;

/*
 * The order here is the order in the menu, and Recent leads it because Recent
 * is where Home opens -- but those are two decisions rather than one, and they
 * have not always agreed. There was a stretch where this list led with Recent
 * and DEFAULT_SCOPE below said `all`, which is a picker that does not lead with
 * the option it is on. Moving one is not moving the other.
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
 * Where the chosen scope is written down, and why the name carries a version.
 *
 * <h2>What v1 could not answer</h2>
 *
 * <p>A stored value is only worth honouring if it was a choice. Under v1 the
 * default was `recent` and the picker wrote on every interaction, so a stored
 * `"recent"` meant either "I chose this" or "I opened the menu once and it
 * wrote down where I already was" -- and nothing on disk told them apart. That
 * mattered then, because `recent` was hiding filed meetings with nothing on
 * screen to say so, and honouring the ambiguous value carried that through the
 * deployment into exactly the browsers it was happening in.
 *
 * <p>So v1 was abandoned wholesale rather than repaired. Everything under v2 is
 * a value somebody selected, because nothing writes this key except the picker
 * -- which is still true now that the default has moved back to Recent. A
 * stored `"all"` is honoured, and so is a stored `"recent"`.
 *
 * <p><b>The key stays at v2.</b> Bumping it again would throw away real choices
 * to fix an ambiguity that no longer exists. And the old `home.scope` entry is
 * left where it is rather than deleted: nothing reads that name any more, and
 * clearing it would mean a write on load, from a page whose whole problem once
 * was doing something surprising on load.
 */
const SCOPE_PREF_KEY = "home.scope.v2";

/**
 * Recent Conversations: what has not been filed anywhere else.
 *
 * <h2>This has moved twice, and the middle step is the one to understand</h2>
 *
 * <p>`recent`, then `all`, and now `recent` again. The move to `all` was not a
 * preference -- it was a bug fix, and undoing it blind would put the bug back.
 *
 * <p>`recent` is `unfiled=true` on the wire, so the list it draws is "your
 * meetings, minus the ones you organised". An account that had filed everything
 * therefore opened Home to a list with nothing in it -- and the page said <b>No
 * conversations</b> and offered to help with a first recording. The
 * archive-lost screen, over a full archive, reached by doing nothing at all.
 *
 * <p>But the default was only how people arrived there. What made it
 * unrecoverable is that an empty list never said <em>which filter had emptied
 * it</em>: the same screen appeared whether the workspace was empty or merely
 * tidy, and the way out was a control you had to remember you had never
 * touched.
 *
 * <p>That is now answered. An empty Recent asks the server whether the
 * workspace holds anything at all, and the two cases get opposite screens --
 * "Everything is in a folder" with the way to the whole list, or the
 * first-recording screen. See {@link EmptyState}, and note that the probe is
 * the only reason this is safe to open on: anybody moving the default again
 * should move that guard with it rather than through it.
 *
 * <p>So this is a product choice once more instead of a trap, and the choice is
 * Recent. Home is what you have not filed yet; the folders in the rail are
 * where the rest of it went.
 */
const DEFAULT_SCOPE: Scope = "recent";

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
  // the left is how you get back to it. See DEFAULT_SCOPE for why that is safe
  // to open on now and was not before.
  //
  // Both filters are remembered until sign-out. Home is a page people leave and
  // come back to constantly — open a meeting, come back, open another — and a
  // filter that reset on every return meant narrowing the list was work you did
  // once per visit rather than once. A new sign-in starts from the defaults;
  // see lib/preferences.ts for why a preference must never outlive its
  // session.
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
      <section className="scrollbar-none h-[calc(100vh-var(--band))] overflow-y-auto px-4 py-4 lg:px-6">
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
              onRetry={() => void meetings.refetch()}
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
 * <p><b>Only on Recent.</b> "Everything is in a folder" describes a list that
 * is hiding rows, which is only true of Recent. On All Conversations an empty
 * list means the workspace is empty, full stop, so the probe below is skipped
 * and the first-recording screen is what shows. That skip is the whole guard:
 * get it wrong and a new account is told its meetings are filed somewhere, and
 * handed a button to another empty list.
 *
 * <p>Home opens on Recent, so this is the common path rather than a corner —
 * which is exactly why it exists. It is the difference between a default that
 * explains itself and the one that used to say "No conversations" to somebody
 * with a hundred of them.
 */
function EmptyState({
  scope,
  when,
  onClearDate,
  onShowAll,
  onRetry,
}: {
  scope: Scope;
  when: DateWindow;
  onClearDate: () => void;
  onShowAll: () => void;
  /** Fetch the list again, for the one state below that cannot explain itself. */
  onRetry: () => void;
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

  /*
   * The folders, because "everything is in a folder" is a claim about them.
   *
   * <p>Already in the cache: the rail fetches this on every page, so reading it
   * here costs nothing and adds no request. Three-state for the same reason
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
  const unexplained =
    scope === "recent" && !filtered && total !== null && total > 0 && folderCount === 0;
  /**
   * The probe was asked and did not answer, so neither screen below is known.
   *
   * <p>Keyed off `total` rather than off `isSuccess`, so the one expression
   * decides it. `isSuccess` with no body is not a state RTK Query produces, but
   * splitting the question across two lines is how the pair drifts apart -- and
   * the drift would land on the screen that tells somebody their account is
   * empty.
   */
  const probeUnresolved =
    scope === "recent" && !filtered && (total === null || folderCount === null);

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
  if (
    scope === "recent" &&
    (workspace.isLoading || workspace.isFetching || folders.isLoading || folders.isFetching)
  ) {
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
          <Button variant="outline" onClick={onShowAll}>
            Show all conversations
          </Button>
        </div>
      </div>
    );
  }

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
