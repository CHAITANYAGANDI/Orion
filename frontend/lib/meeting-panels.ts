/**
 * What each panel of the meeting page is allowed to say, from two facts.
 *
 * <h2>The two dimensions, and why neither alone is enough</h2>
 *
 * <p>A panel on this page is answering two different questions at once, and the
 * page used to answer only the first:
 *
 * <ol>
 *   <li><b>Is the meeting finished?</b> Answered by {@link revealPlan}. A
 *       summary that has not been written yet is "generating", not "missing" —
 *       that distinction is already made, already tested, and stays where it
 *       is.</li>
 *   <li><b>Did the request for it succeed?</b> Answered by {@link
 *       resourceState}. Never asked. Every panel read `Boolean(summary.data)`
 *       or `data?.segments ?? []`, which turns a 500, a 401 during the token
 *       race, a dropped connection and a refetch in flight into the same
 *       thing as a server that answered "there is nothing here".</li>
 * </ol>
 *
 * <p>Together they explain the screenshots. On a <em>finished</em> meeting
 * `revealPlan` correctly stops claiming the summary is being generated — and
 * with the second question never asked, whatever the request did was read as
 * absence. So a failed summary fetch on a READY meeting produced "No summary
 * available." over a summary that was sitting in the database, and the failed
 * transcript fetch beside it produced "Transcript unavailable." over a
 * transcript. Both panels were describing their own network, and calling it the
 * meeting.
 *
 * <h2>The composition</h2>
 *
 * <p>One rule, applied to all three panels:
 *
 * <ol>
 *   <li>Content we have beats everything — including a refetch that failed.</li>
 *   <li>A meeting still being made explains the absence, so the pending state
 *       wins over "error" and over "empty". A summary that does not exist yet is
 *       not a summary that failed to load, and telling somebody to retry a
 *       request for a thing nobody has written is a dead end.</li>
 *   <li>Otherwise the query's own verdict stands, and it may be "empty" only
 *       under the rules in lib/resource-state.</li>
 * </ol>
 */

import { resourceState, type Presence, type ResourceInput } from "@/lib/resource-state";
import { isNotFoundError } from "@/lib/api";
import type { RevealPlan } from "@/lib/processing-stages";
import type { SummaryResponse, TranscriptResponse, ActionItemResponse } from "@/lib/types";

/** Everything a panel can draw. The pending flavours come from {@link RevealPlan}. */
export type PanelState =
  | "ready"
  | "loading"
  | "error"
  | "empty"
  | "waiting"
  | "generating"
  | "preparing"
  | "extracting";

/**
 * The rule above, for one panel.
 *
 * @param query   how the request for this resource is going
 * @param pending why the meeting has none of it yet, or `null` on a meeting
 *                that is finished — in which case absence is a fact about the
 *                meeting rather than about the clock
 */
export function panelState(query: ResourceInput, pending: PanelState | null): PanelState {
  const state = resourceState(query);
  // Rule 1. Something to read beats any news about the request that fetched it.
  if (state === "ready") return "ready";
  // Rule 2. "Still being written" explains the absence better than either
  // "failed" or "there is none", and is the only one of the three that is true
  // while the worker is running.
  if (pending !== null) return pending;
  // Rule 3. loading | error | empty, decided under the rules in resource-state.
  return state;
}

/**
 * The pending flavour for the summary, or `null` when the meeting is finished.
 *
 * <p>`revealPlan` reports `"ready"` and `"empty"` as well, and both mean the
 * same thing here: the meeting is not going to explain this away, so whatever
 * the query says stands.
 */
export function summaryPending(plan: RevealPlan): PanelState | null {
  return plan.summary === "generating" || plan.summary === "waiting" ? plan.summary : null;
}

export function transcriptPending(plan: RevealPlan): PanelState | null {
  return plan.transcript === "preparing" ? "preparing" : null;
}

export function actionItemsPending(plan: RevealPlan): PanelState | null {
  return plan.actionItems === "extracting" || plan.actionItems === "waiting"
    ? plan.actionItems
    : null;
}

/* --------------------------- presence, per body --------------------------- */

/**
 * Whether a transcript body actually carries a transcript.
 *
 * <p>Segments <em>or</em> the flat text, because a document import has no
 * utterances and a transcript from before segments existed has no rows — both
 * are real transcripts that the panel renders from `transcript`, and counting
 * only segments would call them missing.
 */
export function transcriptPresence(body: TranscriptResponse | undefined): Presence {
  if (!body) return "unknown";
  if (body.segments && body.segments.length > 0) return "some";
  return body.transcript && body.transcript.trim().length > 0 ? "some" : "none";
}

/**
 * Whether a summary body carries a summary.
 *
 * <p>A 200 with every field blank is not something the backend produces today —
 * absence is a 404 (see `absent` in lib/resource-state) — but a summary row
 * written from a failed model call could be, and an empty brief should read as
 * an empty brief rather than as a rendered card with nothing in it.
 */
export function summaryPresence(body: SummaryResponse | undefined): Presence {
  if (!body) return "unknown";
  const hasProse =
    (body.shortSummary ?? "").trim().length > 0 ||
    (body.detailedSummary ?? "").trim().length > 0;
  const hasStructure = (body.keyPoints?.length ?? 0) > 0 || (body.sections?.length ?? 0) > 0;
  return hasProse || hasStructure ? "some" : "none";
}

export function actionItemsPresence(body: ActionItemResponse[] | undefined): Presence {
  if (!body) return "unknown";
  return body.length > 0 ? "some" : "none";
}

/* --------------------------- the meeting itself --------------------------- */

/**
 * What the page as a whole should draw, from the one query everything else
 * hangs off.
 *
 * <p>The gate used to be `isLoading` → skeleton, `isError` → error screen. The
 * second half is what makes an open meeting vanish: RTK Query sets `isError`
 * on a <em>refetch</em> that fails while keeping the last good `data`, so a
 * refresh that hit a blip replaced a meeting somebody was reading with an error
 * card about it. `refetchOnMountOrArgChange`, an invalidation after an edit, or
 * simply coming back to the tab are all enough to trigger one.
 */
export type MeetingState = "loading" | "ready" | "missing" | "error";

export interface MeetingQueryInput {
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  /** Whether a meeting body is cached — from `data`, never from `!isError`. */
  hasData: boolean;
  /** Settles which of the two failure screens; see `isNotFoundError`. */
  error: unknown;
}

/**
 * @param isMissing whether `error` is the server saying this meeting does not
 *                  exist. Injected rather than imported so the rule can be
 *                  tested without constructing `FetchBaseQueryError` shapes,
 *                  and so the one place that decides what a 404 means stays
 *                  lib/api.
 */
export function meetingState(q: MeetingQueryInput, isMissing: (error: unknown) => boolean): MeetingState {
  /*
   * A 404 outranks a cached copy, and it is the only failure that does.
   *
   * <p>The priority rule everywhere else on this page is "what we already have
   * beats bad news about the request" — because a 500, a timeout or a 401 say
   * nothing about the meeting, only about this attempt to fetch it. A 404 is
   * different in kind: it is the server successfully answering the question,
   * and the answer is that the meeting is gone. Continuing to show a copy of
   * something deleted in another tab is the one case where the stale copy is
   * the lie.
   */
  if (q.isError && isMissing(q.error)) return "missing";
  // Anything we can still render, we render. Including through a failed
  // refetch: see the type's note.
  if (q.hasData) return "ready";
  if (q.isError) return "error";
  return "loading";
}

/* ------------------------------- the wiring ------------------------------- */

/**
 * The parts of an RTK Query result these rules read.
 *
 * <p>Narrower than `UseQueryResult` on purpose: it is what a test has to
 * construct, and every extra field is one more thing a fixture can get wrong
 * while looking right.
 */
export interface QueryLike<T> {
  data?: T;
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
}

export interface MeetingQueries {
  summary: QueryLike<SummaryResponse>;
  transcript: QueryLike<TranscriptResponse>;
  actions: QueryLike<ActionItemResponse[]>;
}

export interface MeetingPanels {
  summary: PanelState;
  transcript: PanelState;
  actionItems: PanelState;
}

/**
 * All three panels at once, from the three queries and the reveal plan.
 *
 * <h2>Why the wiring is a function and not three lines in the page</h2>
 *
 * <p>Because the wiring is where the remaining mistakes live. `panelState` can
 * be perfect and the page still wrong by passing `Boolean(data)` instead of a
 * presence, or by setting `absent` on the action items — which would turn a
 * missing route into a confident "there are none" — or by handing the summary
 * the transcript's pending flavour. None of that is reachable from the pure
 * rule's tests, and the meeting page is three thousand lines with a WebSocket
 * in it, so none of it is reachable from a page test either.
 *
 * <p>So the page holds no `??` and no `Boolean()` for these three. It calls
 * this, and the argument mapping is asserted in lib/meeting-panels.test.
 */
export function meetingPanels(queries: MeetingQueries, plan: RevealPlan): MeetingPanels {
  return {
    summary: panelState(
      {
        ...queries.summary,
        content: summaryPresence(queries.summary.data),
        /*
         * `getSummary` throws `notFound("Summary not ready")` rather than
         * returning an empty body, so for this endpoint a settled 404 is the
         * proof of absence that a settled 200 is elsewhere.
         */
        absent: isNotFoundError(queries.summary.error),
      },
      summaryPending(plan),
    ),
    transcript: panelState(
      {
        ...queries.transcript,
        content: transcriptPresence(queries.transcript.data),
        // Same again: `getTranscript` throws `notFound("Transcript not ready")`.
        absent: isNotFoundError(queries.transcript.error),
      },
      transcriptPending(plan),
    ),
    actionItems: panelState(
      {
        ...queries.actions,
        content: actionItemsPresence(queries.actions.data),
        /*
         * Deliberately no `absent`. This endpoint returns a list, so `[]` is
         * how it says "none" -- which means a 404 from it is a deleted meeting
         * or a route missing from the deployed build, and reporting that as
         * "no action items were extracted" would turn a deployment skew into a
         * false statement about somebody's commitments.
         */
      },
      actionItemsPending(plan),
    ),
  };
}

/**
 * Whether each resource exists, for {@link revealPlan} and the stage strip.
 *
 * <p>A different question from the one above -- "does this exist yet" is about
 * the meeting, not about the request -- and `some` is the only answer that
 * means yes. A failed request must not tick a stage.
 */
export function meetingHas(queries: MeetingQueries): {
  hasTranscript: boolean;
  hasSummary: boolean;
} {
  return {
    hasTranscript: transcriptPresence(queries.transcript.data) === "some",
    hasSummary: summaryPresence(queries.summary.data) === "some",
  };
}
