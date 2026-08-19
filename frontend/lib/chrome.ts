import { isSettingsPath } from "@/lib/settings-tabs";

/**
 * What the top bar carries on a given page.
 *
 * <p>Two independent rules, in one place because they are the same kind of
 * decision and because inlining either as a `pathname === …` in the JSX puts
 * the reason three regions away from the thing it governs.
 */
export interface HeaderChrome {
  /** The "Ask or search" button. Ctrl-K is bound on the shell and is unaffected. */
  search: boolean;
  /** Import and Record — the two buttons that make a meeting. */
  create: boolean;
}

/**
 * Whether this is the chat.
 *
 * <p>Its own check rather than a string compare at the call site, so a future
 * `/ask/:id` cannot quietly fall out of the rule.
 */
function isChatPath(pathname: string): boolean {
  return pathname === "/ask" || pathname.startsWith("/ask/");
}

/**
 * Decide the header for a pathname.
 *
 * <p><strong>No search on Account Settings.</strong> Search finds meetings, and
 * nothing on those pages is one — so the widest control in the header would be
 * the one thing that cannot act on what is underneath it. On the Integrations
 * tab it would sit directly above a list of connections it does not search,
 * which is the version of the problem somebody actually tries.
 *
 * <p><strong>No Import or Record on the chat.</strong> That page is a
 * conversation with one input, and the two buttons that make a meeting are the
 * two things that navigate away from it. Search stays: asking a question and
 * looking for the meeting the answer came from are the same activity, so the
 * one control worth keeping is the one that finds things.
 *
 * <p>The live recording indicator is not part of this and is never hidden. It
 * is not a button; it is the only evidence that a microphone is open, and an
 * invisible live recording is worse than one that stopped.
 */
export function headerChrome(pathname: string): HeaderChrome {
  return {
    search: !isSettingsPath(pathname),
    create: !isChatPath(pathname),
  };
}
