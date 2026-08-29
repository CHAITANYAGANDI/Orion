"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { isNotFoundError } from "@/lib/api";
import { HOME } from "@/lib/routes";

/**
 * The two ways loading a meeting can fail, told apart.
 *
 * <h2>The bug</h2>
 *
 * <p>The meeting page rendered "Meeting not found" for `isError || !data` — for
 * *any* failure. A dropped connection, a 500, a request that went out before the
 * auth token was attached: all of them told the user their meeting did not
 * exist.
 *
 * <p>Which is false, and it is the most alarming false thing the page could
 * say. The two messages ask for opposite responses: "not found" is final and
 * invites you to give up and go back, while a transient failure wants you to
 * try again in a moment. Saying the first when you mean the second produces the
 * one reaction that does not recover — closing the tab, believing the data is
 * gone.
 *
 * <p>Extracted from the page rather than left inline because the page is ~2,500
 * lines with a dozen queries and a WebSocket, so the branch could not be tested
 * where it was. A bug that reappears silently needs a test that can reach it.
 */
export function MeetingLoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  if (isNotFoundError(error)) {
    return (
      <div className="text-center">
        <p className="text-lg font-medium">Meeting not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          It may have been deleted, or the link may be wrong.
        </p>
        <Button className="mt-4" variant="outline" asChild>
          <Link href={HOME}>Back to your conversations</Link>
        </Button>
      </div>
    );
  }

  /*
   * Everything else. Deliberately says the meeting is still there -- that is
   * the fact the user needs and the one the old screen contradicted -- and
   * offers the action that can actually help.
   *
   * `role="alert"` because this replaces content that was expected to appear;
   * a screen reader that has already moved on would otherwise never hear that
   * it did not.
   */
  return (
    <div className="text-center" role="alert">
      <p className="text-lg font-medium">Couldn&apos;t load this meeting</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The meeting is still there. Something went wrong fetching it.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button variant="default" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href={HOME}>Back to your conversations</Link>
        </Button>
      </div>
    </div>
  );
}
