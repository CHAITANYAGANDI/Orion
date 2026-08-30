"use client";

import * as React from "react";
import { useDispatch } from "react-redux";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * One person's cached data must not outlive their sign-in.
 *
 * <h2>The store survives the sign-in, and that is the problem</h2>
 *
 * <p><code>Providers</code> builds the Redux store once, into a
 * <code>useRef</code>, so it belongs to the React root. The App Router does not
 * remount the root layout on a client navigation, and both halves of a session
 * change are client navigations: Clerk's <code>signOut</code> navigates to
 * <code>afterSignOutUrl</code>, and <code>&lt;SignIn&gt;</code> navigates to
 * <code>fallbackRedirectUrl</code>. Nothing in that sequence necessarily
 * reloads the document, so the same store — and every RTK Query cache entry in
 * it — can carry across
 *
 * <pre>  user A → sign out → user B signs in  </pre>
 *
 * <p>in one page lifetime.
 *
 * <h2>Why the cache keys cannot save us</h2>
 *
 * <p>An RTK Query cache entry is keyed by endpoint name and serialised
 * argument: <code>getMeeting("mtg_1")</code>, <code>getMeetings({page: 0,
 * size: 50})</code>. Not one of them contains a user or a session — they never
 * needed to, because a token decided whose meetings came back. So B's
 * <code>getMeetings({page: 0, size: 50})</code> is a cache <em>hit</em> on A's,
 * and RTK Query serves the cached page synchronously while it revalidates. B
 * sees A's meetings, by title, for as long as that takes.
 *
 * <p>Tags and refetching do not fix it: an invalidation still leaves the stale
 * body in the store and hands it to the component while the refetch is in
 * flight — which, since the resource-state work, is precisely the case that
 * renders cached data rather than a skeleton. That is right for a refresh of
 * your own data and wrong across a change of tenant. The entry has to be gone,
 * not stale, so this drops the whole API cache.
 *
 * <h2>What counts as a change</h2>
 *
 * <p><code>sessionKey</code> — Clerk's session id, or the dev user id in dev
 * mode, which has no sessions. Both are exactly "the sign-in this is", so
 * signing out and back in as the same person counts, and so does switching dev
 * users, which changes the identity the API sees without any navigation at all.
 *
 * <p>Nothing is dropped on the first pass. There is no previous session to
 * belong to, and clearing on mount would throw away a cache that was warmed by
 * this same sign-in.
 */
export function SessionCacheGuard() {
  const { sessionKey, isLoaded } = useAuth();
  const dispatch = useDispatch();
  /** The sign-in the cache in the store belongs to. Null until one is known. */
  const owner = React.useRef<string | null>(null);

  React.useEffect(() => {
    // Before Clerk has loaded, `sessionKey` is "" for want of an answer rather
    // than because nobody is signed in. Recording that would make the real
    // session id look like a change on arrival, and drop a cache for nothing.
    if (!isLoaded) return;

    const previous = owner.current;
    owner.current = sessionKey;
    if (previous === null || previous === sessionKey) return;

    /*
     * `resetApiState`, not `invalidateTags`. See the header: an invalidation
     * marks entries stale and leaves the bodies where they are, and a stale
     * body is still rendered. This removes them.
     */
    dispatch(api.util.resetApiState());
  }, [sessionKey, isLoaded, dispatch]);

  return null;
}
