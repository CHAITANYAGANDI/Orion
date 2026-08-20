import { isSettingsPath } from "@/lib/settings-tabs";

/**
 * What the top bar offers to create, if anything.
 *
 * <p>One value rather than a flag per button, because the choices are exclusive
 * and always have been: a header showing both "New folder" and "Record" would
 * be offering two answers to a question nobody asked.
 */
export type CreateAction = "meeting" | "folder" | "none";

/** What the top bar carries on a given page. */
export interface HeaderChrome {
  /** The "Ask or search" button. Ctrl-K is bound on the shell and is unaffected. */
  search: boolean;
  /** Which create control the header offers. */
  create: CreateAction;
  /** The folder id whose actions belong in the header, or null. */
  folderId: string | null;
  /**
   * There is nothing to put in the top bar on a wide screen.
   *
   * <p>Search is stripped and there is nothing to create, so all that remains
   * is the button that opens the rail — and that is hidden from `lg` up. The
   * bar is then sixty-four pixels of nothing above the page title.
   */
  bare: boolean;
  /**
   * This page ends its own content before the right edge of the window,
   * because a panel is pinned there.
   *
   * <p>The header spans the whole window, so without this its buttons sit
   * above that panel — and Import and Record read as things you do to the AI
   * chat rather than to the list they actually act on. Told the page has a
   * panel, the header stops where the list stops.
   */
  sidePanel: boolean;
}

/** Whether this is the chat. A prefix, so a future `/ask/:id` cannot fall out. */
function isChatPath(pathname: string): boolean {
  return pathname === "/ask" || pathname.startsWith("/ask/");
}

/** The page that exists to record. A prefix, so `/record/:id` cannot fall out. */
function isRecordPath(pathname: string): boolean {
  return pathname === "/record" || pathname.startsWith("/record/");
}

/**
 * Home pins a chat rail to the right edge. A prefix would be wrong here: this
 * is a fact about one page's layout, not about a section of the app.
 */
function hasSidePanel(pathname: string): boolean {
  return pathname === "/home";
}

/**
 * A meeting being read. Its own Share, Export and overflow menu fill the
 * header slot, and Import and Record stand down: on the page for one document,
 * the two buttons that make a *different* one are the two that navigate away
 * from it.
 */
function isMeetingPath(pathname: string): boolean {
  return pathname.startsWith("/meetings/");
}

/** The folder list itself, not a folder. */
function isFolderListPath(pathname: string): boolean {
  return pathname === "/projects" || pathname === "/projects/";
}

/**
 * The folder being looked at, or null.
 *
 * <p>Read from the path rather than passed down, because the header is rendered
 * by the shell and the shell does not know what page it is wrapping. The query
 * for the folder is the same one the page underneath already made, so this
 * costs a cache read rather than a request.
 */
function folderIdFrom(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "projects" ? parts[1] : null;
}

/**
 * Decide the header for a pathname.
 *
 * <p><strong>Account Settings gets nothing.</strong> Search finds meetings, and
 * nothing on those pages is one — so the widest control in the header would be
 * the one thing that cannot act on what is underneath it. On the Integrations
 * tab it would sit directly above a list of connections it does not search,
 * which is the version of the problem somebody actually tries. Import and
 * Record go for the related reason: changing a setting and capturing a call are
 * different sittings, and the two of them there are an invitation to leave a
 * half-finished form.
 *
 * <p>That leaves the bar empty on those pages. It used to stay rendered anyway,
 * on the argument that a page which shifts up by sixty-four pixels when you
 * navigate into settings is worse than a strip of nothing — but the shift
 * happens once, on a deliberate navigation, and the empty strip sits above
 * every settings page for as long as you are on one. So `bare` reports it and
 * the shell drops the bar from `lg` up. Below `lg` it stays: it still carries
 * the button that opens the rail, which is the only way back out.
 *
 * <p><strong>Nothing to create on the chat.</strong> That page is a conversation
 * with one input, and the two buttons that make a meeting are the two things
 * that navigate away from it. Search stays: asking a question and then finding
 * the meeting the answer came from are the same activity.
 *
 * <p><strong>The folder list offers a folder, not a meeting.</strong> A page
 * that lists folders and nothing else has one obvious next action, and Import
 * and Record were competing with it while doing something unrelated to what was
 * on screen. Inside a folder they come back — filing a meeting into the folder
 * you are looking at is exactly the moment to record one.
 *
 * <p><strong>Nothing to create while one is being made.</strong> On /record,
 * and on every other page for as long as the recorder is running or holding
 * audio nobody has saved, Import and Record both go. Record would be offering
 * to start a recording that is already running, and Import would be offering a
 * second way to make a meeting while the first one is still open and still
 * losable — a file picker over a live microphone is a way to lose the call you
 * are on. New folder is untouched: filing something is not making a second
 * recording, and the folder list is the one page whose own action it is.
 *
 * <p>This is also where the live-recording pill went. The docked bar along the
 * bottom is on every page, survives the same navigations, and carries the
 * waveform, the clock, and the two buttons that end the recording — so the
 * header had a smaller copy of a thing already on screen, and clearing it out
 * leaves the recording with one place to be. See components/recording-bar.tsx.
 *
 * @param recording whether the recorder is holding anything — mid-recording,
 *   paused, or stopped with audio not yet saved.
 */
export function headerChrome(pathname: string, recording = false): HeaderChrome {
  const capturing = recording || isRecordPath(pathname);
  return {
    search: !isSettingsPath(pathname),
    create: isFolderListPath(pathname)
      ? "folder"
      : isChatPath(pathname) || isSettingsPath(pathname) || isMeetingPath(pathname) || capturing
        ? "none"
        : "meeting",
    folderId: folderIdFrom(pathname),
    sidePanel: hasSidePanel(pathname),
    bare: isSettingsPath(pathname),
  };
}
