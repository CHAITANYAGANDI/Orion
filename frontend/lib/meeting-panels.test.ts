import { describe, it, expect } from "vitest";
import {
  panelState,
  meetingPanels,
  meetingHas,
  meetingState,
  summaryPending,
  transcriptPending,
  actionItemsPending,
  summaryPresence,
  transcriptPresence,
  actionItemsPresence,
  type MeetingQueries,
  type MeetingQueryInput,
  type PanelState,
} from "@/lib/meeting-panels";
import { revealPlan } from "@/lib/processing-stages";
import { isNotFoundError } from "@/lib/api";
import type { ResourceInput } from "@/lib/resource-state";
import type {
  ActionItemResponse,
  MeetingStatus,
  SummaryResponse,
  TranscriptResponse,
} from "@/lib/types";

/**
 * The six screenshots, as a matrix.
 *
 * <p>Every one of them was a panel that could not tell a failed request from a
 * successful empty one, so every one of them is asserted here against the two
 * inputs that distinguish them: how the request is going, and whether the
 * meeting is finished.
 *
 * <p>The page itself is 3,000 lines with a dozen queries and a WebSocket, and
 * these combinations cannot be staged through it — which is why the decision is
 * a pure function, following the same approach as lib/home-list-state.
 */

/* ------------------------------- fixtures -------------------------------- */

/** A settled, successful response carrying content. */
const OK: ResourceInput = {
  isUninitialized: false,
  isLoading: false,
  isFetching: false,
  isError: false,
  isSuccess: true,
  content: "some",
};

/** The first load of a cache entry: in flight, nothing cached. */
const FIRST_LOAD: ResourceInput = {
  ...OK,
  isLoading: true,
  isFetching: true,
  isSuccess: false,
  content: "unknown",
};

/** A settled failure with nothing behind it — a 500, a timeout, a 401. */
const FAILED: ResourceInput = {
  ...OK,
  isError: true,
  isSuccess: false,
  content: "unknown",
};

/** A refetch that failed over content that is still cached. */
const FAILED_REFETCH: ResourceInput = { ...OK, isError: true };

/** Settled, successful, and the body really was empty. */
const EMPTY: ResourceInput = { ...OK, content: "none" };

/** A settled 404 — which is how getSummary and getTranscript report absence. */
const NOT_FOUND: ResourceInput = { ...FAILED, absent: true };

const READY = revealPlan({ status: "READY", hasTranscript: true, hasSummary: true });
const TRANSCRIBING = revealPlan({ status: "TRANSCRIBING", hasTranscript: false, hasSummary: false });
const SUMMARIZING = revealPlan({ status: "SUMMARIZING", hasTranscript: true, hasSummary: false });

/* ------------------------------ the panels ------------------------------- */

describe("panelState", () => {
  describe("the summary", () => {
    const summary = (q: ResourceInput, plan = READY) => panelState(q, summaryPending(plan));

    it("renders the summary on a settled successful response", () => {
      expect(summary(OK)).toBe("ready");
    });

    it("does not say 'No summary available' before the request has resolved", () => {
      // The screenshot. `Boolean(summary.data)` was false here, and false was
      // read as "this meeting has no summary".
      expect(summary(FIRST_LOAD)).toBe("loading");
    });

    it("does not say 'No summary available' when the request failed", () => {
      expect(summary(FAILED)).toBe("error");
    });

    it("keeps the summary on screen when a background refetch fails", () => {
      // The priority rule: a transient failure must not blank a summary
      // somebody is reading.
      expect(summary(FAILED_REFETCH)).toBe("ready");
    });

    it("keeps the summary on screen during a background refetch", () => {
      expect(summary({ ...OK, isFetching: true })).toBe("ready");
    });

    it("says 'No summary available' for a settled 404, which is how absence arrives", () => {
      // `MeetingService.getSummary` throws `notFound("Summary not ready")`
      // rather than returning an empty body, so this is the real empty state.
      expect(summary(NOT_FOUND)).toBe("empty");
    });

    it("says 'No summary available' for a settled 200 that carried nothing", () => {
      expect(summary(EMPTY)).toBe("empty");
    });

    it("says the summary is being generated rather than missing while one is", () => {
      expect(summary(NOT_FOUND, SUMMARIZING)).toBe("generating");
      expect(summary(FIRST_LOAD, TRANSCRIBING)).toBe("waiting");
    });

    it("prefers 'still being written' to 'failed' on a meeting still processing", () => {
      // Retrying a request for something nobody has written yet is a dead end,
      // and "generating" is the true sentence in both cases.
      expect(summary(FAILED, SUMMARIZING)).toBe("generating");
    });

    it("shows a summary that exists even while the meeting is reprocessing", () => {
      expect(summary(OK, SUMMARIZING)).toBe("ready");
    });
  });

  describe("the transcript", () => {
    const transcript = (q: ResourceInput, plan = READY) => panelState(q, transcriptPending(plan));

    it("renders the transcript on a settled successful response", () => {
      expect(transcript(OK)).toBe("ready");
    });

    it("does not say 'Transcript unavailable.' before the request has resolved", () => {
      expect(transcript(FIRST_LOAD)).toBe("loading");
    });

    it("does not say 'Transcript unavailable.' when the request failed", () => {
      expect(transcript(FAILED)).toBe("error");
    });

    it("does not erase an already-rendered transcript during a refetch", () => {
      expect(transcript({ ...OK, isFetching: true })).toBe("ready");
    });

    it("keeps the transcript when a refetch fails", () => {
      expect(transcript(FAILED_REFETCH)).toBe("ready");
    });

    it("says 'Transcript unavailable.' only once a settled request proved it", () => {
      expect(transcript(NOT_FOUND)).toBe("empty");
      expect(transcript(EMPTY)).toBe("empty");
    });

    it("says the transcript is being prepared while the meeting is transcribing", () => {
      expect(transcript(FAILED, TRANSCRIBING)).toBe("preparing");
      expect(transcript(FIRST_LOAD, TRANSCRIBING)).toBe("preparing");
    });
  });

  describe("the action items", () => {
    const actions = (q: ResourceInput, plan = READY) => panelState(q, actionItemsPending(plan));

    it("renders the list on a settled successful response", () => {
      expect(actions(OK)).toBe("ready");
    });

    it("treats a settled empty list as a real empty state", () => {
      // The one case where "No action items were extracted." is true: the
      // server answered, and the answer was none.
      expect(actions(EMPTY)).toBe("empty");
    });

    it("never turns an undefined list into an empty one", () => {
      // `data ?? []` is the whole bug. Every one of these used to produce
      // "No action items were extracted." — and, above it, the cheerful
      // "Everything here is done."
      expect(actions(FIRST_LOAD)).toBe("loading");
      expect(actions(FAILED)).toBe("error");
      expect(actions({ ...OK, isUninitialized: true, content: "unknown", isSuccess: false })).toBe(
        "loading",
      );
    });

    it("retains cached items while fetching", () => {
      expect(actions({ ...OK, isFetching: true })).toBe("ready");
    });

    it("retains cached items when a refetch errors", () => {
      expect(actions(FAILED_REFETCH)).toBe("ready");
    });

    it("reports a 404 as a fault, because this endpoint answers none with []", () => {
      // Deliberately unlike the summary and the transcript. A 404 here means a
      // deleted meeting or a route missing from the deployed build, and calling
      // that "there are none" is how a deployment skew becomes a lie about
      // somebody's commitments.
      expect(actions({ ...FAILED, absent: false })).toBe("error");
    });

    it("says the items are being extracted while the meeting is processing", () => {
      expect(actions(FAILED, SUMMARIZING)).toBe("extracting");
      expect(actions(FIRST_LOAD, TRANSCRIBING)).toBe("waiting");
    });
  });

  describe("the panels do not lie about each other", () => {
    it("does not produce three false empty messages when all three fail at once", () => {
      // One dropped connection fails every request on the page. The old code
      // answered with three confident sentences: no transcript, no summary, no
      // action items — a meeting that appeared to have been wiped.
      const states: PanelState[] = [
        panelState(FAILED, summaryPending(READY)),
        panelState(FAILED, transcriptPending(READY)),
        panelState(FAILED, actionItemsPending(READY)),
      ];

      expect(states).toEqual(["error", "error", "error"]);
      expect(states).not.toContain("empty");
    });

    it("does not say 'No summary available' beside action items that loaded", () => {
      // The exact screenshot: the summary tab showing its empty message with a
      // populated action-items card underneath it, which is a combination the
      // backend cannot produce — both are written by `applyResult` in one
      // transaction — and so could only have come from the panel describing its
      // own network.
      expect(panelState(FAILED, summaryPending(READY))).toBe("error");
      expect(panelState(OK, actionItemsPending(READY))).toBe("ready");
    });

    it("lets one panel fail without disturbing the two that succeeded", () => {
      expect(panelState(FAILED, transcriptPending(READY))).toBe("error");
      expect(panelState(OK, summaryPending(READY))).toBe("ready");
      expect(panelState(OK, actionItemsPending(READY))).toBe("ready");
    });
  });
});

/* --------------------------- the pending flavours ------------------------- */

describe("the pending flavours", () => {
  it("are null on a finished meeting, so the query's verdict stands", () => {
    expect(summaryPending(READY)).toBeNull();
    expect(transcriptPending(READY)).toBeNull();
    expect(actionItemsPending(READY)).toBeNull();
  });

  it("are null on a failed meeting, which has its own screen", () => {
    const failed = revealPlan({ status: "FAILED", hasTranscript: false, hasSummary: false });
    expect(summaryPending(failed)).toBeNull();
    expect(transcriptPending(failed)).toBeNull();
    expect(actionItemsPending(failed)).toBeNull();
  });

  it("never treat a finished meeting's genuine absence as pending", () => {
    // `revealPlan` reports `summary: "empty"` for a READY meeting with none.
    // Mapping that to a pending flavour would leave a finished meeting pulsing
    // "Generating summary…" for ever.
    const bare = revealPlan({ status: "READY", hasTranscript: false, hasSummary: false });
    expect(summaryPending(bare)).toBeNull();
    expect(transcriptPending(bare)).toBeNull();
  });

  it("cover every in-flight status", () => {
    const statuses: MeetingStatus[] = ["CREATED", "UPLOADED", "QUEUED", "TRANSCRIBING", "SUMMARIZING", "EXTRACTING"];
    for (const status of statuses) {
      const plan = revealPlan({ status, hasTranscript: false, hasSummary: false });
      expect(summaryPending(plan), status).not.toBeNull();
      expect(actionItemsPending(plan), status).not.toBeNull();
    }
  });
});

/* ------------------------------- presence -------------------------------- */

describe("presence", () => {
  it("reads a missing transcript body as unknown, not as none", () => {
    expect(transcriptPresence(undefined)).toBe("unknown");
  });

  it("counts a transcript with segments", () => {
    const body = { segments: [{ id: "1" }], transcript: "" } as unknown as TranscriptResponse;
    expect(transcriptPresence(body)).toBe("some");
  });

  it("counts a transcript that is only flat text", () => {
    // A document import has no utterances, and a transcript from before
    // segments existed has no rows. Both are real transcripts, and counting
    // only segments would call them missing.
    const body = { segments: [], transcript: "Hello." } as unknown as TranscriptResponse;
    expect(transcriptPresence(body)).toBe("some");
  });

  it("calls a body with neither segments nor text empty", () => {
    const body = { segments: [], transcript: "   " } as unknown as TranscriptResponse;
    expect(transcriptPresence(body)).toBe("none");
  });

  it("reads a missing summary body as unknown", () => {
    expect(summaryPresence(undefined)).toBe("unknown");
  });

  it("counts a summary with prose or with structure", () => {
    expect(
      summaryPresence({ shortSummary: "We shipped." } as unknown as SummaryResponse),
    ).toBe("some");
    expect(
      summaryPresence({ shortSummary: "", keyPoints: ["a"] } as unknown as SummaryResponse),
    ).toBe("some");
    expect(
      summaryPresence({ shortSummary: "", sections: [{ key: "outline" }] } as unknown as SummaryResponse),
    ).toBe("some");
  });

  it("calls a blank summary body empty rather than a rendered card with nothing in it", () => {
    expect(
      summaryPresence({
        shortSummary: " ",
        detailedSummary: "",
        keyPoints: [],
      } as unknown as SummaryResponse),
    ).toBe("none");
  });

  it("keeps an undefined action-items list apart from an empty one", () => {
    expect(actionItemsPresence(undefined)).toBe("unknown");
    expect(actionItemsPresence([])).toBe("none");
    expect(actionItemsPresence([{ id: "1" } as ActionItemResponse])).toBe("some");
  });
});

/* ---------------------------- the meeting itself -------------------------- */

describe("meetingState", () => {
  const LOADED: MeetingQueryInput = {
    isUninitialized: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    hasData: true,
    error: undefined,
  };

  const gate = (overrides: Partial<MeetingQueryInput>) =>
    meetingState({ ...LOADED, ...overrides }, isNotFoundError);

  it("shows the meeting once it has arrived", () => {
    expect(gate({})).toBe("ready");
  });

  it("is loading, not missing, before the request resolves", () => {
    // The screenshot. "Meeting not found" for a meeting that was simply still
    // being fetched is the most alarming false thing this page can say.
    expect(
      gate({ isLoading: true, isFetching: true, isSuccess: false, hasData: false }),
    ).toBe("loading");
  });

  it("is loading when the query has not been started", () => {
    expect(gate({ isUninitialized: true, isSuccess: false, hasData: false })).toBe("loading");
  });

  it("is loading in the gap between states, with no data and no error", () => {
    // What a cache entry looks like for a frame after `refetch()` on a failed
    // entry. `!data` used to be enough to declare the meeting missing.
    expect(gate({ isSuccess: false, hasData: false })).toBe("loading");
  });

  it("says missing only when the server actually answered 404", () => {
    expect(gate({ isError: true, isSuccess: false, hasData: false, error: { status: 404 } })).toBe(
      "missing",
    );
  });

  it.each([
    ["401 — the token had not been attached yet", { status: 401 }],
    ["403 — deliberately distinct from 404 in this API", { status: 403 }],
    ["500 — the server broke", { status: 500 }],
    ["502 — a bad gateway", { status: 502 }],
    ["503 — unavailable", { status: 503 }],
    ["504 — a gateway timeout", { status: 504 }],
    ["FETCH_ERROR — the network dropped", { status: "FETCH_ERROR" }],
    ["TIMEOUT_ERROR", { status: "TIMEOUT_ERROR" }],
    ["PARSING_ERROR — a non-JSON 5xx body", { status: "PARSING_ERROR", originalStatus: 502 }],
    ["a thrown Error with no status", new Error("boom")],
    ["undefined, because isError can outrun error", undefined],
  ])("does not call the meeting missing for %s", (_label, error) => {
    expect(gate({ isError: true, isSuccess: false, hasData: false, error })).toBe("error");
  });

  it("keeps the meeting visible during a background refetch", () => {
    expect(gate({ isFetching: true })).toBe("ready");
  });

  it.each([
    ["a 500", { status: 500 }],
    ["a dropped connection", { status: "FETCH_ERROR" }],
    ["a 401 from an expired token", { status: 401 }],
  ])("keeps the meeting visible when a background refetch fails with %s", (_label, error) => {
    // The regression that made an open meeting vanish. RTK Query sets isError
    // on a failed refetch while keeping the last good data, and this page
    // refetches constantly.
    expect(gate({ isError: true, isFetching: false, error })).toBe("ready");
  });

  it("drops a cached meeting only for a 404, which settles the question", () => {
    // The one failure that is an answer rather than a failure: the meeting was
    // deleted in another tab, and continuing to show a copy of it is the lie.
    expect(gate({ isError: true, error: { status: 404 } })).toBe("missing");
  });

  it("never reports a generic error as missing, at any combination", () => {
    const bools = [false, true];
    for (const isLoading of bools)
      for (const isFetching of bools)
        for (const isError of bools)
          for (const isSuccess of bools)
            for (const hasData of bools)
              for (const error of [undefined, { status: 500 }, { status: 401 }, { status: "FETCH_ERROR" }]) {
                const result = meetingState(
                  {
                    isUninitialized: false,
                    isLoading,
                    isFetching,
                    isError,
                    isSuccess,
                    hasData,
                    error,
                  },
                  isNotFoundError,
                );
                expect(result, JSON.stringify({ isError, hasData, error })).not.toBe("missing");
              }
  });
});

/* ------------------------------- the wiring ------------------------------- */

/**
 * The argument list, asserted.
 *
 * <p>`panelState` can be perfect and the page still wrong: a `Boolean(data)`
 * where a presence belongs, `absent` set on the action items, the summary handed
 * the transcript's pending flavour. None of that is reachable from the rule's
 * own tests, and the page is three thousand lines with a WebSocket in it, so
 * none of it is reachable from a page test either. It is reachable from here.
 */
describe("meetingPanels", () => {
  const q = <T,>(over: Partial<import("@/lib/meeting-panels").QueryLike<T>> = {}) => ({
    isUninitialized: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    ...over,
  });

  const summaryBody = { shortSummary: "We shipped." } as unknown as SummaryResponse;
  const transcriptBody = { segments: [{ id: "1" }], transcript: "" } as unknown as TranscriptResponse;
  const actionsBody = [{ id: "a" } as ActionItemResponse];

  const loaded: MeetingQueries = {
    summary: q<SummaryResponse>({ data: summaryBody }),
    transcript: q<TranscriptResponse>({ data: transcriptBody }),
    actions: q<ActionItemResponse[]>({ data: actionsBody }),
  };

  const failed = <T,>() =>
    q<T>({ isError: true, isSuccess: false, error: { status: 500 } });

  it("renders all three on a finished meeting whose requests succeeded", () => {
    expect(meetingPanels(loaded, READY)).toEqual({
      summary: "ready",
      transcript: "ready",
      actionItems: "ready",
    });
  });

  it("reports three failures as three failures, not three empty panels", () => {
    // One dropped connection fails every request on the page. The old code
    // answered with three confident sentences about a meeting that looked wiped.
    expect(
      meetingPanels(
        {
          summary: failed<SummaryResponse>(),
          transcript: failed<TranscriptResponse>(),
          actions: failed<ActionItemResponse[]>(),
        },
        READY,
      ),
    ).toEqual({ summary: "error", transcript: "error", actionItems: "error" });
  });

  it("reads a 404 from the summary and the transcript as absence", () => {
    // Those two endpoints throw `notFound("Summary not ready")` /
    // `notFound("Transcript not ready")` instead of returning an empty body.
    const gone = { status: 404 };
    const panels = meetingPanels(
      {
        summary: q<SummaryResponse>({ isError: true, isSuccess: false, error: gone }),
        transcript: q<TranscriptResponse>({ isError: true, isSuccess: false, error: gone }),
        actions: q<ActionItemResponse[]>({ data: [] }),
      },
      READY,
    );

    expect(panels.summary).toBe("empty");
    expect(panels.transcript).toBe("empty");
  });

  it("reads a 404 from the action items as a fault, not as 'there are none'", () => {
    // The asymmetry that matters. This endpoint returns a list, so a 404 means
    // a deleted meeting or a route missing from the deployed build -- and
    // calling that "no action items were extracted" turns a deployment skew
    // into a false statement about somebody's commitments.
    const panels = meetingPanels(
      {
        ...loaded,
        actions: q<ActionItemResponse[]>({
          isError: true,
          isSuccess: false,
          error: { status: 404 },
        }),
      },
      READY,
    );

    expect(panels.actionItems).toBe("error");
  });

  it("gives each panel its own pending flavour", () => {
    const inFlight = {
      summary: q<SummaryResponse>({ isLoading: true, isSuccess: false }),
      transcript: q<TranscriptResponse>({ isLoading: true, isSuccess: false }),
      actions: q<ActionItemResponse[]>({ isLoading: true, isSuccess: false }),
    };

    // Mid-transcription: nothing exists yet, and the summary is waiting on the
    // transcript rather than being written.
    expect(meetingPanels(inFlight, TRANSCRIBING)).toEqual({
      summary: "waiting",
      transcript: "preparing",
      actionItems: "waiting",
    });

    // Once the transcript is in, the same three requests mean different things.
    // `revealPlan` reports the transcript as `ready` here, so the transcript
    // panel falls through to its own query state rather than to a placeholder
    // about work that is finished.
    expect(meetingPanels(inFlight, SUMMARIZING)).toEqual({
      summary: "generating",
      transcript: "loading",
      actionItems: "extracting",
    });
  });

  it("keeps each panel visible through its own failed refetch", () => {
    const panels = meetingPanels(
      {
        summary: q<SummaryResponse>({ data: summaryBody, isError: true, error: { status: 500 } }),
        transcript: q<TranscriptResponse>({
          data: transcriptBody,
          isError: true,
          error: { status: "FETCH_ERROR" },
        }),
        actions: q<ActionItemResponse[]>({ data: actionsBody, isError: true, error: { status: 503 } }),
      },
      READY,
    );

    expect(panels).toEqual({ summary: "ready", transcript: "ready", actionItems: "ready" });
  });

  it("does not let one panel's failure change another's verdict", () => {
    const panels = meetingPanels(
      { ...loaded, summary: failed<SummaryResponse>() },
      READY,
    );

    expect(panels).toEqual({ summary: "error", transcript: "ready", actionItems: "ready" });
  });

  it("treats an empty action-items list as a real empty state", () => {
    const panels = meetingPanels(
      { ...loaded, actions: q<ActionItemResponse[]>({ data: [] }) },
      READY,
    );

    expect(panels.actionItems).toBe("empty");
  });

  it("never turns an undefined action-items list into an empty one", () => {
    for (const over of [
      { isLoading: true, isSuccess: false },
      { isError: true, isSuccess: false, error: { status: 500 } },
      { isUninitialized: true, isSuccess: false },
      { isFetching: true, isSuccess: false },
    ]) {
      const panels = meetingPanels(
        { ...loaded, actions: q<ActionItemResponse[]>(over) },
        READY,
      );
      expect(panels.actionItems, JSON.stringify(over)).not.toBe("empty");
    }
  });
});

describe("meetingHas", () => {
  const q = <T,>(data?: T) => ({
    data,
    isUninitialized: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: data !== undefined,
  });

  it("says a resource exists only when a body actually carries it", () => {
    const has = meetingHas({
      summary: q<SummaryResponse>({ shortSummary: "x" } as unknown as SummaryResponse),
      transcript: q<TranscriptResponse>({
        segments: [{ id: "1" }],
      } as unknown as TranscriptResponse),
      actions: q<ActionItemResponse[]>([]),
    });

    expect(has).toEqual({ hasTranscript: true, hasSummary: true });
  });

  it("does not tick a stage on the strength of a request that failed", () => {
    // The stage strip reads these. A failed summary fetch ticking "Summary ✓"
    // would be the processing-stages bug and this one at the same time.
    const has = meetingHas({
      summary: q<SummaryResponse>(undefined),
      transcript: q<TranscriptResponse>(undefined),
      actions: q<ActionItemResponse[]>(undefined),
    });

    expect(has).toEqual({ hasTranscript: false, hasSummary: false });
  });
});
