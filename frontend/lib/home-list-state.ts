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
 *
 * <h2>Where the rules actually live now</h2>
 *
 * <p>In lib/resource-state, which is the same four rules in the same order for
 * every async panel in the app — because the same bug was in all of them, and
 * the meeting page's transcript, summary and action items were each fixing it
 * their own slightly different way. This file is that rule with Home's names on
 * it: `skeleton`/`list` rather than `loading`/`ready`, and a row count rather
 * than a `Presence`.
 *
 * <p>Kept as its own function rather than inlined at the call site so the
 * matrix below it stays asserted against Home's vocabulary, and so a future
 * rule that is genuinely Home's alone has somewhere to go that is not
 * everybody's.
 */
import { resourceState } from "@/lib/resource-state";

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
  const state = resourceState({
    // The remembered filters not being read back yet is Home's version of "the
    // question has not been put to the server" -- the query is skipped until
    // then, which is why every other flag reads as settled-with-nothing.
    asked: q.restored,
    isUninitialized: q.isUninitialized,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isError: q.isError,
    isSuccess: q.isSuccess,
    /*
     * `null` stays `unknown` and 0 stays `none`. The whole bug is one line
     * away here: `q.count ?? 0` would compile, pass the type checker, and put
     * "No conversations" back over a full archive.
     *
     * A 404 is never absence for this list. `GET /meetings` answers an empty
     * workspace with an empty page, so a 404 from it means the route is not on
     * the deployed build -- which is a fault to report, not zero meetings.
     */
    content: q.count === null ? "unknown" : q.count > 0 ? "some" : "none",
  });

  switch (state) {
    case "ready":
      return "list";
    case "error":
      return "error";
    case "empty":
      return "empty";
    default:
      return "skeleton";
  }
}
