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
 * <h2>Recent means recent, and nothing else narrows it</h2>
 *
 * <p>There was a scope picker above the list with two options: <i>Recent
 * Conversations</i> and <i>All Conversations</i>. <i>Recent</i> sent
 * `unfiled=true` — a folder filter under a name about time — and it was the
 * default, so filing a meeting into a folder made it vanish from the page
 * called Recent. That is most of why this screen needed a probe and three
 * different empty states: they existed to explain a list that was hiding rows
 * for a reason its own label did not mention.
 *
 * <p>Both are gone. This list is <b>the newest {@link RECENT_SIZE} conversations
 * in the window, wherever they are filed</b>, and Library is the complete
 * archive with the folders. The two pages differ by how much they show rather
 * than by a hidden predicate, which is a difference a person can see.
 *
 * <p>Two consequences, both deliberate:
 *
 * <ul>
 *   <li><b>"Everything is in a folder" cannot happen.</b> No filter here can
 *       hide a meeting, so an empty list means the window is empty or the
 *       account is. The probe that told those apart is gone with the third
 *       case it existed for. What survives untouched is the harder rule it was
 *       built on: never read a failed or unresolved request as an empty
 *       account.</li>
 *   <li><b>There is no longer a view of "meetings not in a folder".</b> That
 *       was only ever reachable as this page's default, never as a filter
 *       somebody chose. It is a real capability lost and it is recorded as one
 *       — see docs/v2-implementation/feature-parity.md §3b.</li>
 * </ul>
 *
 * <p>The stored `home.scope.v2` preference is left where it is rather than
 * cleared. Nothing reads it, and clearing it would mean a write on load from a
 * page whose whole problem once was doing something surprising on load.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  ListChecks,
  FileAudio,
  Download,
  Mic,
  CalendarDays,
  RotateCw,
} from "lucide-react";
import { useGetMeetingsQuery, useGetPreferencesQuery } from "@/lib/api";
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

/**
 * How many conversations "recent" is.
 *
 * <p>A bound rather than a filter, and it is what separates this page from
 * Library. Both ask the same question of the same endpoint; this one asks for
 * the top of the answer. Twenty is four or five days for somebody in meetings
 * all week, and it is short enough that the list is still a glance rather than
 * an archive — which is the whole distinction being drawn.
 *
 * <p>When there are more, the page says so and points at Library. A truncated
 * list that does not admit it is the same lie as a filtered one that does not
 * name its filter.
 */
const RECENT_SIZE = 20;

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
      size: RECENT_SIZE,
      from: when.from ?? undefined,
      to: when.to ?? undefined,
      // NO `unfiled`. It is the parameter this page used to send and the reason
      // its name was a lie: a meeting recorded inside a folder was filed there
      // and disappeared from Recent, which is not what recent means. The only
      // thing narrowing this list now is the window above it and the size
      // above that, and both are stated on screen.
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
       * One request per visit, against a short page. The docked watcher covers
       * meetings this tab started or opened; this covers the rest, including
       * one processed on another device.
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
              {/* The label used to carry the whole explanation for a list that
                  hid filed meetings. It has nothing to explain away now, so it
                  says the one thing left that is not obvious: that being in a
                  folder does not keep a conversation off this page. The line
                  that admits the list is short is under the list, where the
                  shortness becomes apparent. */}
              <p className="mt-0.5 text-foot text-ink-3">
                Your newest conversations, wherever they are filed.
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
            <EmptyState when={when} onClearDate={() => setWhen(ANY_TIME)} />
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.key} className="mb-6">
                  <h3 className="v2-label mb-2">{group.label}</h3>
                  <ul className="space-y-2">
                    {group.items.map((meeting) => (
                      <ConversationRow key={meeting.id} meeting={meeting} />
                    ))}
                  </ul>
                </div>
              ))}

              {/* Said only when it is true, and said where the list runs out.
                  A page showing twenty of two hundred conversations with
                  nothing at the bottom is a list somebody scrolls to the end of
                  and believes. `totalElements` is on the response already, so
                  this costs no request. */}
              {data && data.totalElements > data.content.length && (
                <p className="pt-1 text-foot text-ink-3">
                  Showing the {data.content.length} most recent of{" "}
                  <span className="tabular">{data.totalElements}</span>.{" "}
                  <Link
                    href={LIBRARY}
                    className="underline underline-offset-2 hover:text-ink-2"
                  >
                    All of them are in Library
                  </Link>
                  .
                </p>
              )}
            </>
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
 * Where you are in the day, and the two things the list underneath is doing.
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
 * <p>And nothing here is <em>invented</em> to fill the space. Both lines below
 * are counted from the rows already on screen, so they cost no request and
 * cannot disagree with the list under them.
 *
 * <h2>Two lines, because they are two different things</h2>
 *
 * <p>This is the correction that matters. A meeting still transcribing is the
 * product working; a meeting that failed is a job that needs a person. Putting
 * them in one sentence — or under one heading called "Needs you" — teaches
 * people that the loud line is usually nothing, which is exactly how a real
 * failure gets scrolled past.
 *
 * <p>So a failure is stated first, in the danger colour, at body size. Normal
 * processing is a second line, quieter and smaller, and it is phrased as
 * activity rather than as a demand. Neither is a heading, and neither claims to
 * be a to-do list.
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

  /*
   * From the list already on screen. `undefined` means it has not arrived, and
   * nothing is claimed until it has.
   *
   * FAILED is terminal, so it is not in `making` -- the two counts name
   * disjoint sets of rows and the numbers can be read independently.
   */
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

      {/* The one thing on this page that needs a person. Stated on its own, in
          the danger colour, at reading size -- and never merged into a sentence
          with the line below it. A failed transcription was previously findable
          only by scrolling for a red badge. */}
      {failed > 0 && (
        <p className="mt-2 text-body text-danger">
          {failed === 1
            ? "One conversation could not be transcribed."
            : `${failed} conversations could not be transcribed.`}
        </p>
      )}

      {/* Activity, not a demand. Quieter and smaller than the line above,
          because a meeting still being made is the product working normally and
          the reader has nothing to do about it. It says what is happening so
          that a row further down carrying a progress bar is expected rather
          than surprising. */}
      {making > 0 && (
        <p className="mt-1 text-foot text-ink-3">
          {making === 1
            ? "One conversation is still being made."
            : `${making} conversations are still being made.`}
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
 * Nothing to show, and which of the two reasons it is.
 *
 * <h2>There used to be four screens here, and a request to choose between them</h2>
 *
 * <p>This list sent `unfiled=true`, so an empty one meant one of three things:
 * the window is empty, everything is filed into a folder, or the account has
 * nothing at all. Those want different screens and the page could not tell them
 * apart from what it had — so it asked the server for one more row and read the
 * folder list, and drew "Everything is in a folder", or a first-recording
 * screen, or an "I cannot explain this" screen when the two answers
 * contradicted each other.
 *
 * <p>All of that existed to explain a filter. The filter is gone: nothing here
 * hides a meeting, so an empty list has two causes and both are already known
 * without asking anything. The probe, the folder read and two screens went with
 * the third case.
 *
 * <p><b>What did not go</b> is the rule underneath them, which was the actual
 * production bug: an empty list is a <em>claim about the account</em>, and only
 * a settled, successful, genuinely empty response may make it. That lives in
 * {@link homeListState} and is why this component is only ever reached for one.
 * Home showed "No conversations — Record / Import" to accounts with hundreds of
 * meetings because `data?.content ?? []` read *no answer* as *the answer is
 * none*; nothing in this change goes near that.
 */
function EmptyState({
  when,
  onClearDate,
}: {
  when: DateWindow;
  onClearDate: () => void;
}) {
  if (when.from !== null || when.to !== null) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
        <CalendarDays className="h-8 w-8 text-muted-foreground" />
        {/* "from" rather than "in", and the label verbatim: it reads correctly
            for all three shapes the window can take — "from Today", "from Last
            7 days", "from Thu, 13 Aug" — where lower-casing turns a date into
            "thu, 13 aug". */}
        <p className="mt-3 font-medium">Nothing from {when.label}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          There are no conversations in this stretch of time. Your other
          conversations are still here.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={onClearDate}>
            Show any time
          </Button>
          <Button variant="outline" asChild>
            <Link href={LIBRARY}>Go to Library</Link>
          </Button>
        </div>
      </div>
    );
  }

  // No window, no filter, and a settled empty answer. There is nothing left for
  // it to mean: the account has no conversations yet.
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <FileAudio className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-medium">No conversations</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Record a meeting from your browser, or bring in a file you already have.
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
