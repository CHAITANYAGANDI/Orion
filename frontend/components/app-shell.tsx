"use client";

/**
 * The frame every page sits in.
 *
 * Three regions and a rule about each. The rail on the left is for places —
 * Home, the chat, what you connect to, your notifications, and the folders you
 * filed things in. The bar across the top is for the things you do: create a
 * meeting, or find one. Everything else — the plan, the settings, the account
 * itself — lives behind the account button, because none of it is somewhere you
 * go during work.
 *
 * <p>The bell sits in the rail, in the row with the wordmark. It is a list of
 * things that happened, which makes it a place rather than an action, and the
 * top bar was where it was most likely to be crowded out — on a narrow window
 * that row already carries a menu button, Import and Record. The wordmark row
 * is the one piece of chrome that is on screen on every page in every state,
 * which is what a thing that has to be noticed needs.
 *
 * <p>The top bar is not the same on every page. Search leaves it on Account
 * Settings; Import and Record leave it on the chat, and leave again for as long
 * as a recording is in hand. Every rule lives in lib/chrome.ts with its reason,
 * rather than as pathname compares buried in the JSX three regions from the
 * thing they govern.
 *
 * What is deliberately absent from the bottom of the rail: the desktop-app card
 * and the plan upsell that used to sit there. A sidebar is navigation; an
 * advertisement in it is a permanent piece of chrome that is never the thing
 * anybody is looking for. The account button now holds that corner instead,
 * which is the opposite case — it is not selling anything, and the bottom-left
 * is where thirty years of software has taught people to look for who they are
 * signed in as.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Home, Sparkles, Plug, Menu, Mic, Search, Upload, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { headerChrome } from "@/lib/chrome";
import { RecordingProvider, useRecording } from "@/lib/recording-context";
import { useRecordingStartedMutation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notification-bell";
import { SearchCommand } from "@/components/search-command";
import { ImportDialog } from "@/components/import-dialog";
import { RecordingBar } from "@/components/recording-bar";
import { AccountMenu } from "@/components/account-menu";
import { FolderTree } from "@/components/folder-tree";
import { FolderDialog } from "@/components/folder-dialog";
import { FolderHeaderActions } from "@/components/folder-header-actions";
import { HEADER_SLOT_ID } from "@/components/header-slot";

/**
 * The places.
 *
 * Three, and the shortness is the point: Record, Import and Search were nav
 * items and are now buttons in the top bar, because they are things you do
 * rather than places you are. Action items left the rail entirely — they live
 * beside the chat on Home, where they are read.
 */
const NAV = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/ask", label: "AI Chat", icon: Sparkles },
  { href: "/settings/integrations", label: "Integrations", icon: Plug },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  // The provider wraps the shell, not the other way round, so the recorder
  // outlives every route change inside the app group — and so the header can
  // read it. See lib/recording-context.tsx.
  return (
    <RecordingProvider>
      <AppShellInner>{children}</AppShellInner>
    </RecordingProvider>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const recorder = useRecording();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [newFolder, setNewFolder] = React.useState(false);
  const fullBleed = pathname === "/home" || pathname === "/ask";
  // Anything other than idle means the recorder is holding something: asking
  // for the microphone, running, paused, or stopped with audio not yet saved.
  // The header and the docked bar both key off it, so they can never disagree
  // about whether a recording is happening.
  const capturing = recorder.state !== "idle";
  const chrome = headerChrome(pathname, capturing);
  /*
   * How far every page has to end above the docked control bar.
   *
   * Measured rather than guessed. The bar is not one height: the waveform
   * appears when recording starts, the no-audio warning stacks on top of it,
   * and a progress bar opens underneath while saving. A fixed `pb-44` was right
   * for one of those and cut the last line of the transcript off in the others,
   * which is the one line somebody is reading. `--recording-bar` is published
   * by the bar itself; the extra 3rem is so the newest words clear it rather
   * than touch it.
   */
  // The recorder alone now. The bar stands down for the upload -- the dialog
  // has that stretch to itself -- so room reserved for it there would be a
  // three-rem hole at the foot of a page with nothing docked over it.
  const barShowing = capturing;
  const clearance = barShowing ? "calc(var(--recording-bar, 0px) + 3rem)" : undefined;

  // Ctrl/Cmd-K from anywhere. Bound on the shell rather than on the input so it
  // works while the focus is in a transcript, a chat box or nothing at all.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="flex">
        {/*
         * Sticky, not static.
         *
         * As a static flex item the rail scrolled away with the page, so on any
         * long document — a transcript, most of all — navigating meant
         * scrolling back to the top first. `self-start` is the part that is
         * easy to miss: a flex item stretches to the height of the row by
         * default, and an element already as tall as its container has nothing
         * to stick to, so `sticky` silently does nothing without it.
         */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-card transition-transform",
            "lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 lg:self-start lg:overflow-y-auto",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-16 items-center gap-2 px-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-4 w-4" />
            </div>
            <span className="font-semibold">Recallix</span>
            {/* Beside the name, at the far end of the row rather than touching
                it: a bell abutting the wordmark reads as part of the logo, and
                the first thing anybody would try to click on a logo is the
                logo. It moved up out of the navigation below because it is the
                one thing here that changes on its own, and something that
                arrives while you are looking elsewhere has to be somewhere the
                eye already goes. */}
            <NotificationBell onNavigate={() => setMobileOpen(false)} />
          </div>

          <nav className="flex flex-col gap-1 p-3">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <FolderTree onNavigate={() => setMobileOpen(false)} />

          {/* Last, and against the bottom edge. It was under the wordmark,
              which is the most valuable row in the rail and the one the eye
              lands on first — spent on a control that is only ever wanted at
              the end of something: sign out, settings, which account this is.
              The folder tree above it is `flex-1`, so this is pushed down by
              the space rather than positioned into it, and a rail with fifty
              folders in it keeps the same footer as a rail with none. */}
          <div className="mt-auto border-t pt-3">
            <AccountMenu />
          </div>
        </aside>

        {mobileOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        <div className="flex min-h-screen flex-1 flex-col lg:pl-0">
          <header
            className={cn(
              "sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-6",
              // Nothing in it on a wide screen — see `bare` in lib/chrome.ts.
              // It stays below `lg`, where it still carries the button that
              // opens the rail.
              chrome.bare && "lg:hidden",
            )}
          >
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
              <Menu />
            </Button>

            {/* Not an input. Clicking it opens the real one, which needs the
                whole width of the screen for its suggestions — an inline box
                that grew a dropdown on focus would have to fight the header for
                room and would lose on a laptop.

                Not on every page — see lib/chrome.ts for where and why. Ctrl-K
                works everywhere regardless: the shortcut is bound on the shell,
                and taking it away would break the habit without freeing
                anything on screen. */}
            {chrome.search && (
              <button
                type="button"
                onClick={() => setSearching(true)}
                className="flex h-9 max-w-sm flex-1 items-center gap-2 rounded-full border bg-card px-4 text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                <Search className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">Ask or search</span>
                <kbd className="hidden rounded border px-1.5 text-[10px] font-medium sm:inline">
                  Ctrl K
                </kbd>
              </button>
            )}

            <div
              className={cn(
                "flex flex-1 items-center justify-end gap-2",
                // Stop where the page's own content stops. The header spans the
                // window, so on a page with a pinned rail these buttons landed
                // above it — and Import and Record then read as controls on the
                // AI chat rather than on the list of meetings they actually
                // act on. The margin is the rail's width; see the `aside` in
                // app/(app)/home/page.tsx, which states the same 28rem.
                chrome.sidePanel && "lg:mr-[28rem]",
              )}
            >
              {/* No live-recording pill here any more. It said what the
                  docked bar at the bottom of the screen already says, on the
                  same pages, through the same navigations — and the bar says it
                  with a waveform, a clock and the two buttons that end the
                  recording. See components/recording-bar.tsx.

                  What this page is for creating; see lib/chrome.ts.

                  Import is a dialog rather than a route: a file arrives more
                  often than anything else creates a meeting, and it should not
                  cost leaving whatever is on screen. /upload still exists for
                  the fuller form — filing straight into a project — and for
                  direct links. */}
              {chrome.create === "meeting" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => setImporting(true)}
                  >
                    <Upload className="h-4 w-4" />
                    <span className="hidden sm:inline">Import</span>
                  </Button>
                  <RecordButton />
                </>
              )}

              {chrome.create === "folder" && (
                <Button size="sm" className="gap-2" onClick={() => setNewFolder(true)}>
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New folder</span>
                </Button>
              )}

              {/* Beside Record, and only inside a folder. Rename and delete are
                  what you do to the folder you are standing in, so they belong
                  where the other things you do to it already are. */}
              {chrome.folderId && <FolderHeaderActions folderId={chrome.folderId} />}

              {/* Filled by the page underneath, when it has controls of its
                  own — a meeting's Share, Export and overflow menu. Empty and
                  zero-width otherwise. See components/header-slot.tsx. */}
              <div id={HEADER_SLOT_ID} className="flex items-center gap-2" />
            </div>
          </header>

          {/* Home and the chat lay out their own full-height panes, so they get
              the viewport unpadded. Everything else is a document and reads
              better in a measured column. */}
          {fullBleed ? (
            <main className="flex-1" style={{ paddingBottom: clearance }}>
              {children}
            </main>
          ) : (
            <main className="flex-1 p-4 lg:p-8" style={{ paddingBottom: clearance }}>
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </main>
          )}
        </div>
      </div>

      <SearchCommand open={searching} onOpenChange={setSearching} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <FolderDialog open={newFolder} onOpenChange={setNewFolder} />
      {/* Rendered by the shell, not the record page, for the same reason the
          recorder is: it has to survive the navigation it is telling you is
          safe to make. Renders nothing when there is no recording. */}
      <RecordingBar />
    </div>
  );
}

/**
 * Record, meaning record.
 *
 * This was a link to a page that asked two questions before opening a
 * microphone. Both are gone: the capture mode had one answer left, and the
 * consent tick — a legal requirement in two-party-consent jurisdictions and
 * under GDPR — was removed on request. The button now does the thing it is
 * named after, which is the only defensible reading of a button called Record.
 *
 * One consequence is carried through rather than papered over: nothing is
 * asserted about consent any more, so nothing is claimed about it. See where
 * the meeting is created in components/recording-bar.tsx.
 *
 * The route is pushed before the microphone is asked for, so the page is on
 * screen behind the browser's permission prompt and it is obvious what is
 * being asked for and by whom.
 */
function RecordButton() {
  const recorder = useRecording();
  const router = useRouter();
  const [announceRecording] = useRecordingStartedMutation();

  function onRecord() {
    router.push("/record");
    if (recorder.state !== "idle") return;
    void recorder.start().then(() => {
      // The server cannot observe a microphone, and the point of telling it is
      // the account's other devices. Fired and forgotten: a notification that
      // could not be written must never be why a recording did not start.
      void announceRecording();
    });
  }

  return (
    <Button size="sm" className="gap-2" onClick={onRecord}>
      <Mic className="h-4 w-4" />
      <span className="hidden sm:inline">Record</span>
    </Button>
  );
}
