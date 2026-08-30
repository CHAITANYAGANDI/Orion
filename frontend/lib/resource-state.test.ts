import { describe, it, expect } from "vitest";
import {
  resourceState,
  presenceOf,
  presenceOfList,
  type ResourceInput,
} from "@/lib/resource-state";

/**
 * The rule that six panels were each getting wrong in their own way.
 *
 * <h2>Why a matrix and not only page tests</h2>
 *
 * <p>Rendering cannot reach all of these. A cached body of `undefined` with no
 * error, nothing in flight and `isSuccess` false is a real RTK Query state —
 * it is what a query looks like for the frame after `refetch()` is called on a
 * failed entry — and it is awkward to stage through a component. It is also
 * exactly where the bug lived.
 *
 * <p>That gap was measured on the Home version of this bug rather than assumed:
 * mutating the rule to treat "no cached page" as empty left every page test
 * passing, because each of them that had no data also had an error, and the
 * error branch caught it first.
 *
 * <p>So the decision is a pure function and every combination is asserted here.
 */

/** A settled, successful, non-empty response — the ordinary case. */
const OK: ResourceInput = {
  isUninitialized: false,
  isLoading: false,
  isFetching: false,
  isError: false,
  isSuccess: true,
  content: "some",
};

function state(overrides: Partial<ResourceInput>) {
  return resourceState({ ...OK, ...overrides });
}

describe("resourceState", () => {
  it("is ready for a settled response that carries content", () => {
    expect(state({})).toBe("ready");
  });

  describe("no answer is not an answer of none", () => {
    it("is loading when nothing is cached and nothing has failed", () => {
      // THE bug, in one line. `unknown` means "we do not know"; `?? []` and
      // `Boolean(data)` both turn it into "the server said none".
      expect(
        state({ content: "unknown", isSuccess: false, isLoading: false, isFetching: false }),
      ).toBe("loading");
    });

    it("is loading before anything has been asked", () => {
      expect(state({ isUninitialized: true, content: "unknown", isSuccess: false })).toBe(
        "loading",
      );
    });

    it("is loading while a precondition is unmet", () => {
      // `asked: false` is a skipped query — the Clerk token is not ready, or
      // the remembered filters have not been read back. Every other flag on a
      // skipped query reads as "settled with nothing", which is the trap.
      expect(state({ asked: false, content: "unknown", isSuccess: false })).toBe("loading");
    });

    it("is loading even when a skipped query somehow reports success", () => {
      // Belt and braces: `asked` is checked before anything else, so a stale
      // `isSuccess` from a previous arg cannot produce an empty state for a
      // question nobody has asked yet.
      expect(state({ asked: false, content: "none" })).toBe("loading");
    });

    it("is loading during the very first fetch", () => {
      expect(state({ isLoading: true, isFetching: true, isSuccess: false, content: "unknown" })).toBe(
        "loading",
      );
    });

    it("does not confirm emptiness while a refetch over an empty body is in flight", () => {
      // That body may be about to be replaced by content. Announcing emptiness
      // in the meantime is a guess, and it is the guess that reads as data loss.
      expect(state({ isFetching: true, content: "none" })).toBe("loading");
    });
  });

  describe("what we already have beats news about the request", () => {
    it("stays ready through a background refetch", () => {
      expect(state({ isFetching: true })).toBe("ready");
    });

    it("stays ready when a background refetch fails", () => {
      // The priority rule. A transient failure must not make visible data
      // disappear — the good copy is still the best thing on the screen.
      expect(state({ isError: true, isSuccess: false, isFetching: false })).toBe("ready");
    });

    it("stays ready when a refetch fails with a 404 on an absence-by-404 endpoint", () => {
      // Content on screen still beats a rejection, `absent` or not. Whether a
      // *meeting* that 404s should be dropped is a different question, and
      // `meetingState` answers it separately.
      expect(state({ isError: true, absent: true, isSuccess: false })).toBe("ready");
    });
  });

  describe("a failure is a failure, not an emptiness", () => {
    it("is an error when the request failed and left nothing behind", () => {
      expect(state({ isError: true, isSuccess: false, content: "unknown" })).toBe("error");
    });

    it("is an error even when a previous response was empty", () => {
      // `none` from an earlier fetch is not proof about *this* one, and the
      // reader needs to know the refresh did not land.
      expect(state({ isError: true, isSuccess: false, content: "none" })).toBe("error");
    });

    it("is an error rather than empty for every transport failure", () => {
      // 401 during the token race, a 500, a dropped connection: none of them
      // says anything about whether the resource exists.
      expect(state({ isError: true, isSuccess: false, content: "unknown", isFetching: false })).toBe(
        "error",
      );
    });
  });

  describe("absence answered by a status rather than a body", () => {
    it("is empty for a settled 404 on an endpoint where 404 means absence", () => {
      // `MeetingService.getSummary` throws `notFound("Summary not ready")`, so
      // for the summary and the transcript a 404 is the proof of emptiness that
      // a 200 is everywhere else.
      expect(state({ isError: true, isSuccess: false, content: "unknown", absent: true })).toBe(
        "empty",
      );
    });

    it("is an error for the same 404 where a list would have said none", () => {
      // Action items return a list, so `[]` is their empty answer. A 404 from
      // that route means a deleted meeting or a route missing from the deployed
      // build — a fault to report, not "there are none".
      expect(state({ isError: true, isSuccess: false, content: "unknown", absent: false })).toBe(
        "error",
      );
    });

    it("treats an omitted absent flag as 'a 404 here is a fault'", () => {
      const { absent: _omitted, ...rest } = { ...OK, isError: true, isSuccess: false, content: "unknown" as const, absent: undefined };
      expect(resourceState(rest)).toBe("error");
    });
  });

  describe("the only route to an empty state", () => {
    it("is a settled, successful, genuinely empty body", () => {
      expect(state({ content: "none" })).toBe("empty");
    });

    it("requires the success flag, not merely the absence of an error", () => {
      // Settled-looking but never successful. A skeleton for a frame costs
      // nothing; a false "there is nothing here" costs trust.
      expect(state({ content: "none", isSuccess: false })).toBe("loading");
    });
  });

  it("never invents an empty state for an unforeseen combination", () => {
    // Every combination of the five flags against every presence. The claim is
    // narrow and total: "empty" is reachable only with a settled successful
    // empty body, or a settled 404 on an absence-by-404 endpoint.
    const bools = [false, true];
    for (const isUninitialized of bools)
      for (const isLoading of bools)
        for (const isFetching of bools)
          for (const isError of bools)
            for (const isSuccess of bools)
              for (const absent of bools)
                for (const asked of bools)
                  for (const content of ["some", "none", "unknown"] as const) {
                    const input: ResourceInput = {
                      asked,
                      isUninitialized,
                      isLoading,
                      isFetching,
                      isError,
                      isSuccess,
                      absent,
                      content,
                    };
                    if (resourceState(input) !== "empty") continue;
                    const settledEmpty =
                      asked && !isUninitialized && isSuccess && content === "none" && !isError;
                    const settledAbsent = asked && !isUninitialized && isError && absent;
                    expect(
                      settledEmpty || settledAbsent,
                      `empty from ${JSON.stringify(input)}`,
                    ).toBe(true);
                  }
  });
});

describe("presenceOfList", () => {
  it("keeps 'no answer' apart from 'the answer is none'", () => {
    expect(presenceOfList(undefined)).toBe("unknown");
    expect(presenceOfList(null)).toBe("unknown");
    expect(presenceOfList([])).toBe("none");
    expect(presenceOfList([1])).toBe("some");
  });
});

describe("presenceOf", () => {
  it("reads a missing body as unknown and a present one as some", () => {
    expect(presenceOf(undefined)).toBe("unknown");
    expect(presenceOf(null)).toBe("unknown");
    expect(presenceOf({ a: 1 })).toBe("some");
  });

  it("lets the caller say a body that arrived is still empty", () => {
    expect(presenceOf({ text: "" }, (b) => (b as { text: string }).text === "")).toBe("none");
    expect(presenceOf({ text: "x" }, (b) => (b as { text: string }).text === "")).toBe("some");
  });
});
