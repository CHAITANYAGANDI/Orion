/**
 * Which of four things Home should draw, from the state of one query.
 *
 * <h2>The bug</h2>
 *
 * <p>Home decided with `groupByDay(data?.content ?? [])` and
 * `groups.length === 0`, guarded only by `isLoading`. That `?? []` is where it
 * went wrong: it turns *no answer* into *the answer is none*. Four distinct
 * situations collapsed into one screen —
 *
 * <ul>
 *   <li>the request failed and `data` is undefined,</li>
 *   <li>a refetch is in flight over an empty cached page,</li>
 *   <li>nothing has been asked for yet,</li>
 *   <li>the server genuinely returned zero meetings,</li>
 * </ul>
 *
 * <p>— and only the last of them means what the screen said. So a dropped
 * connection or a 500 told somebody with two hundred meetings that they had
 * none, over a picker still reading "All Conversations" and "Any time", which
 * is the detail that made it unbelievable rather than merely wrong.
 *
 * <p>`isLoading` did not cover it because it is only true for the *first* load
 * of a cache entry. A refetch sets `isFetching`; an error sets neither.
 *
 * <h2>The rules, in priority order</h2>
 *
 * <ol>
 *   <li><b>Rows we already have beat everything.</b> A background refetch, and
 *       a background refetch that *failed*, both keep the list on screen.
 *       Replacing meetings somebody is reading with a skeleton or an error
 *       because a refresh went wrong is throwing away the good copy.</li>
 *   <li><b>An error with nothing usable is an error</b>, and says so, with a
 *       way to try again — never "you have no conversations".</li>
 *   <li><b>Anything unresolved is a skeleton.</b> Including a refetch over an
 *       empty cached page: that page may be about to be replaced by rows, and
 *       announcing an empty account in the meantime is a guess.</li>
 *   <li><b>Only a settled, successful, genuinely empty page</b> is allowed to
 *       say the account has nothing in it.</li>
 * </ol>
 *
 * <p>Pure and separate from the component so each rule can be asserted on its
 * own. The bug was a boolean expression nobody could see all of at once.
 */
export type HomeListState = "skeleton" | "error" | "empty" | "list";

export interface HomeListInput {
  /**
   * Whether the remembered filters have been read back.
   *
   * <p>Until they have, the query is skipped — so `isLoading` is false over a
   * list that was never asked for, and every other flag reads as "settled with
   * nothing". This is why the old code needed `!restored` beside `isLoading`.
   */
  restored: boolean;
  isUninitialized: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  /**
   * Rows in the cached page, or **null when there is no usable page at all**.
   *
   * <p>The distinction the bug erased. `null` is "we do not know"; `0` is "the
   * server said none". Passing `data?.content.length ?? 0` here would
   * reintroduce it exactly.
   */
  count: number | null;
}

export function homeListState(q: HomeListInput): HomeListState {
  // Nothing has been asked yet. Not an empty account -- an unasked question.
  if (!q.restored || q.isUninitialized) return "skeleton";

  // Rule 1. Known-good rows survive a failed or in-flight refresh.
  if (q.count !== null && q.count > 0) return "list";

  // Rule 2. Settled as rejected, with nothing worth showing behind it.
  if (q.isError) return "error";

  // Rule 3. Still in motion, or holding nothing to reason about.
  if (q.isLoading || q.isFetching || q.count === null) return "skeleton";

  // Rule 4. The only route to the empty screen.
  if (q.isSuccess && q.count === 0) return "empty";

  /*
   * Unreachable with RTK Query's flags as documented, and deliberately not an
   * exhaustiveness error. A state nobody predicted should cost a skeleton for a
   * frame, not a false statement about somebody's data -- which is the entire
   * lesson of the bug this file exists for.
   */
  return "skeleton";
}
