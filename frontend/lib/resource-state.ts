/**
 * One rule for every async resource on the screen: what may this panel say?
 *
 * <h2>The bug, in one sentence</h2>
 *
 * <p>Six panels each decided for themselves whether they had nothing, and every
 * one of them decided it with `?? []` or `!data`. Both of those read <em>no
 * answer</em> as <em>the answer is none</em> — so a dropped connection, a 500, a
 * request that went out before the token was attached, and a refetch still in
 * flight all came out looking exactly like a server that had successfully
 * replied "there is nothing here".
 *
 * <p>The result was six sentences that were confidently false: "Transcript
 * unavailable." over a transcript, "No summary available." over a summary, "No
 * action items were extracted." over a list of them, "No conversations" over a
 * full archive. Each is worse than an error message, because an error invites
 * you to wait and try again while these invite you to conclude your data is
 * gone.
 *
 * <h2>The rule</h2>
 *
 * <p><b>An empty state is a claim about the server's answer, so it needs one.</b>
 * A panel may say a resource is empty only when the request settled, settled
 * successfully, and the successful body genuinely contained nothing.
 *
 * <h2>The four states, in priority order</h2>
 *
 * <ol>
 *   <li><b>Data we already have beats everything.</b> A background refetch, and
 *       a background refetch that <em>failed</em>, both keep what is on screen.
 *       Replacing a transcript somebody is reading with a spinner or an error
 *       because a refresh went wrong throws away the good copy to report news
 *       about a copy nobody asked for.</li>
 *   <li><b>Settled as rejected, with nothing behind it, is an error</b> — and
 *       says so, with a way to try again. Never "there is nothing here".</li>
 *   <li><b>Anything unresolved is loading.</b> Including a refetch over a
 *       cached-empty body: that body may be about to be replaced by content,
 *       and announcing emptiness in the meantime is a guess.</li>
 *   <li><b>Only a settled, successful, genuinely empty body</b> may say the
 *       resource is empty.</li>
 * </ol>
 *
 * <p>Pure, and separate from every component that uses it, because the bug was
 * a boolean expression nobody could see all of at once — and because rendering
 * cannot reach all of these combinations. A cached body of `undefined` with no
 * error and nothing in flight is a real RTK Query state and an awkward one to
 * stage through a component; it is also exactly where the bug lived.
 */

/** What a panel is allowed to draw. */
export type ResourceState = "loading" | "error" | "empty" | "ready";

/**
 * What the cached body actually proves about the resource.
 *
 * <p>Three values, not two, and that is the whole point. `"unknown"` is "we do
 * not have an answer"; `"none"` is "the server answered, and the answer was
 * nothing". Collapsing them is the bug — `data?.items ?? []` produces exactly
 * that collapse, and so does `Boolean(data)` when `data` is undefined for four
 * different reasons.
 */
export type Presence = "some" | "none" | "unknown";

export interface ResourceInput {
  /**
   * Whether the question has actually been put to the server.
   *
   * <p>False while a precondition is unmet — the remembered filters have not
   * been read back, the Clerk token is not ready, the query is `skip`ped. A
   * skipped RTK Query reports `isUninitialized` and every other flag reads as
   * "settled with nothing", which is precisely the trap this file exists for.
   *
   * <p>Defaults to true, because most resources have no precondition.
   */
  asked?: boolean;
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  /**
   * What is cached, as a three-state — <b>never</b> `data?.x.length ?? 0`.
   *
   * <p>Writing that here would reintroduce the entire bug at the one call site
   * that was supposed to have removed it.
   */
  content: Presence;
  /**
   * Whether the failure that settled this query was the server saying the
   * resource does not exist.
   *
   * <h3>Why an empty state can arrive as an error</h3>
   *
   * <p>Two of Orion's endpoints answer absence with a status rather than with a
   * body. `MeetingService.getTranscript` throws `notFound("Transcript not
   * ready")` and `getSummary` throws `notFound("Summary not ready")` when the
   * row is not there — so for those two, "the server proved there is nothing"
   * is a settled <em>404</em>, not a settled 200 carrying an empty object.
   *
   * <p>That is why this flag exists instead of the rule being "only `isSuccess`
   * may say empty". Without it a meeting that genuinely has no summary — a
   * short recording that caught no speech, a document that failed to summarise
   * — would show "Couldn't load the summary" for ever, which is the same class
   * of lie in the other direction.
   *
   * <p><b>Set it only where a 404 really means absence.</b> Action items and
   * insights return a list, so `[]` is their empty answer and a 404 from them
   * means something else is wrong — a deleted meeting, or a route that is not
   * on the deployed build. Passing `true` there would turn a broken endpoint
   * into a confident "there are none".
   */
  absent?: boolean;
}

export function resourceState(q: ResourceInput): ResourceState {
  // Nothing has been asked. Not an empty resource — an unasked question.
  if (q.asked === false || q.isUninitialized) return "loading";

  // Rule 1. Known-good content survives a failed or in-flight refresh.
  if (q.content === "some") return "ready";

  /*
   * Rule 2. Settled as rejected, with nothing worth showing behind it.
   *
   * `absent` is the one rejection that is an answer rather than a failure: a
   * 404 from an endpoint whose way of saying "there is none" is a 404. See the
   * field's own note -- it is deliberately not inferred from the status here,
   * because whether a 404 means absence depends entirely on which endpoint was
   * asked.
   */
  if (q.isError) return q.absent ? "empty" : "error";

  // Rule 3. Still in motion, or holding nothing to reason about.
  if (q.isLoading || q.isFetching || q.content === "unknown") return "loading";

  // Rule 4. The only route to an empty state.
  if (q.isSuccess && q.content === "none") return "empty";

  /*
   * Unreachable with RTK Query's flags as documented, and deliberately not an
   * exhaustiveness error. A state nobody predicted should cost a skeleton for a
   * frame, not a false statement about somebody's data — which is the entire
   * lesson of the bug this file exists for.
   */
  return "loading";
}

/**
 * `Presence` for a list, from a body that may not have arrived.
 *
 * <p>A helper rather than a habit: the point is that the `undefined` case
 * answers `"unknown"` and not `"none"`, and having one place that gets it right
 * is better than fifteen call sites that each have to remember to.
 */
export function presenceOfList(items: readonly unknown[] | undefined | null): Presence {
  if (items === undefined || items === null) return "unknown";
  return items.length > 0 ? "some" : "none";
}

/**
 * `Presence` for a body that either exists or does not.
 *
 * <p>Takes the whole response as well as the emptiness test, because those are
 * two different questions and the summary panel needs both: a response that
 * arrived carrying no summary is `"none"`, while no response at all is
 * `"unknown"`, and `Boolean(summary)` cannot tell them apart.
 */
export function presenceOf(
  body: unknown,
  isEmpty: (body: NonNullable<unknown>) => boolean = () => false,
): Presence {
  if (body === undefined || body === null) return "unknown";
  return isEmpty(body) ? "none" : "some";
}
