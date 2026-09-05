"use client";

/**
 * The frame every page sits in.
 *
 * <h2>Two regions, where there were four</h2>
 *
 * <p>There was a 256px navigation rail on the left, a 64px header across the
 * top, the page, and a 448px pane on the right: 320px of permanent chrome on a
 * 1440px window, before the page got a pixel. The rail held two links, a folder
 * tree, a bell, an allowance meter and an account button, and the header held
 * global actions and the page's own actions in one row — which is why it needed
 * a rulebook to stop them colliding.
 *
 * <p>What is left is a 48px band and the page. Everything the rail carried
 * either moved into the band (the bell, the account, and the allowance inside
 * it) or became a destination in it — Library is where folders live now. The
 * band never changes shape from one page to the next, which is what lets it be
 * 48px and is why lib/chrome.ts is six lines instead of a hundred.
 *
 * <p>The side pane survived, because it is the one column that is genuinely
 * about the page beside it: the chat asking questions of the transcript it sits
 * next to. It is a pane of the shell rather than an `<aside>` inside the page so
 * that it runs the full height of the window and the page stops where it
 * begins.
 *
 * <h2>What this file is still responsible for</h2>
 *
 * <p>All of it survives the change of shape, and each is here rather than in a
 * page because it has to outlive a navigation:
 *
 * <ul>
 *   <li>the recorder, which keeps running when you leave /record</li>
 *   <li>the docked recording bar and the processing dock that report on it</li>
 *   <li>the clearance every page leaves for them</li>
 *   <li>⌘K, bound on the window so it works with focus anywhere</li>
 *   <li>the search overlay, which is opened from components three deep</li>
 *   <li>the import dialog, and the folder it files into</li>
 *   <li>the side pane's portal target and its open/expanded state</li>
 *   <li>navigation, in two shapes: the band and the bottom tabs</li>
 * </ul>
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { bandChrome } from "@/lib/chrome";
import { ASK, HOME } from "@/lib/routes";
import { SIDE_PANE_ID, useSidePane } from "@/components/side-pane";
import { RecordingProvider, useRecording } from "@/lib/recording-context";
import { SearchCommand } from "@/components/search-command";
import { closeSearch, openSearch, useSearchOverlay } from "@/lib/search-overlay";
import { ImportDialog } from "@/components/import-dialog";
import { RecordingBar } from "@/components/recording-bar";
import { ProcessingDock } from "@/components/processing-dock";
import { FolderHeaderActions } from "@/components/folder-header-actions";
import { HEADER_SLOT_ID } from "@/components/header-slot";
import { AppBand } from "@/components/v2/app-band";
import { MobileTabs } from "@/components/v2/mobile-tabs";
import { cn } from "@/lib/utils";

/**
 * How wide the side pane is.
 *
 * <p>A constant now, where it used to be draggable. The measure is the point of
 * the V2 layout — a reading column of 680px, protected — and a pane the reader
 * can drag is a pane that can take that width away one accidental grab at a
 * time. 400px is the margin column from the design system, which is what the
 * pane is: the same 680 + 40 + 400 the rest of the app is built to.
 *
 * <p>See docs/ui-redesign/v2-design-system.md. `lib/pane-size.ts` and
 * `components/pane-resizer.tsx` still exist and are still tested; they are
 * retired in the sweep at the end rather than deleted from under a component
 * that might still want them.
 */
const PANE_W = "26rem";

export function AppShell({ children }: { children: React.ReactNode }) {
  // The provider wraps the shell, not the other way round, so the recorder
  // outlives every route change inside the app group — and so the band can
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
  // A store rather than local state: the box is the only search in the app, and
  // "Search in folder" opens it from a menu three components deep with a query
  // already in it. See lib/search-overlay.
  const searching = useSearchOverlay();
  const [importing, setImporting] = React.useState(false);
  // Anything other than idle means the recorder is holding something: asking
  // for the microphone, running, paused, or stopped with audio not yet saved.
  // The band and the docked bar both key off it, so they can never disagree
  // about whether a recording is happening.
  const capturing = recorder.state !== "idle";
  const chrome = bandChrome(pathname, capturing);
  // The two pages that draw their own full-height scrollers. Everything else
  // gets the shell's container; see `<main>` below.
  const fullBleed = pathname === HOME || pathname === ASK;
  // Filled by the page underneath, when it has one. See components/side-pane.tsx.
  const pane = useSidePane();
  const showPane = pane.occupied && pane.open;

  /*
   * How far every page has to end above what is docked at the bottom.
   *
   * Measured rather than guessed. The recording bar is not one height: the
   * waveform appears when recording starts, the no-audio warning stacks on top
   * of it, and a progress bar opens underneath while saving. A fixed `pb-44`
   * was right for one of those and cut the last line off the transcript in the
   * others, which is the one line somebody is reading. `--recording-bar` is
   * published by the bar itself; the extra 3rem is so the newest words clear it
   * rather than touch it.
   *
   * The recorder alone. The bar stands down for an upload -- the dialog has
   * that stretch to itself -- so room reserved for it there would be a
   * three-rem hole at the foot of a page with nothing docked over it.
   *
   * The bottom tabs are added on top of it below `md`, in the class rather than
   * here, because they are a breakpoint away and an inline style cannot be.
   */
  const dock = capturing ? "calc(var(--recording-bar, 0px) + 3rem)" : "0px";

  // Ctrl/Cmd-K from anywhere. Bound on the shell rather than on the input so it
  // works while the focus is in a transcript, a chat box or nothing at all.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="min-h-screen bg-background"
      /*
       * Published here rather than only on the pane, because things that are
       * `fixed` have to clear it too — the recording bar along the bottom and
       * the mini player over a transcript both span the window. Zero when the
       * pane is closed, so a bar over a page with no pane runs the whole way
       * across.
       *
       * `--rail-w` is published as zero and kept for one reason: two fixed
       * elements outside this file still read it (`components/recording-bar.tsx`
       * and the meeting page's mini player). Both are rebuilt in later phases,
       * and dropping the variable before then would put them under a rail that
       * no longer exists. See docs/v2-implementation/implementation-notes.md.
       */
      style={
        {
          "--rail-w": "0px",
          "--side-pane-w": showPane ? PANE_W : "0px",
          "--dock": dock,
        } as React.CSSProperties
      }
    >
      <AppBand
        pathname={pathname}
        create={chrome.create}
        recording={capturing}
        onImport={() => setImporting(true)}
      />

      {/* Wraps below `lg`, and only there. The pane is a column beside the page
          on a desktop and a block underneath it on a phone, which is one
          declaration rather than a second copy of the pane. `pt-band` is what
          the fixed band above costs. */}
      <div className="flex flex-wrap pt-band lg:flex-nowrap">
        {/* `w-full` below `lg` is what makes the pane wrap underneath rather
            than squeeze in beside; `min-w-0` is what stops a wide transcript
            from pushing the pane off the screen instead of scrolling itself. */}
        <div className="flex w-full min-w-0 flex-col lg:w-auto lg:flex-1">
          {/*
           * The page's own controls, and the folder's.
           *
           * <p>They were at the right-hand end of the old top bar, sharing it
           * with Import, Record and search — which is what that file's rulebook
           * was refereeing. They are out of the band entirely now: the band is
           * global, and a folder's rename belongs beside the folder.
           *
           * <p>This row has no height of its own. Both children carry their own
           * padding and the portal target is `empty:hidden`, so on the great
           * majority of pages — which put nothing here — it contributes exactly
           * zero pixels rather than a strip of nothing above the title. That
           * was the `bare` flag's whole job, and it is now structural instead of
           * a rule. See components/header-slot.tsx.
           */}
          <div className="flex items-center justify-end gap-2 px-4 lg:px-6">
            {chrome.folderId && (
              <div className="flex items-center gap-2 py-3">
                <FolderHeaderActions folderId={chrome.folderId} />
              </div>
            )}
            <div id={HEADER_SLOT_ID} className="flex items-center gap-2 py-3 empty:hidden" />
          </div>

          {/*
           * Home and the chat lay out their own full-height scrollers, so they
           * get the viewport unpadded. Everything else is still a document in a
           * measured container — the per-page measures land as each screen is
           * rebuilt, and until then a page with no container at all is a line
           * of text 1400px wide.
           *
           * The clearance underneath is the shell's, at both breakpoints: what
           * is docked at the bottom of a phone is the recording bar AND the
           * tabs, and a page that clears only one of them ends under the other.
           */}
          <main
            className={cn(
              "flex-1",
              "pb-[calc(var(--dock)+var(--tabbar))] md:pb-[var(--dock)]",
              !fullBleed && "px-4 pt-4 lg:px-6 lg:pt-6",
            )}
          >
            {fullBleed ? children : <div className="mx-auto w-full max-w-doc">{children}</div>}
          </main>
        </div>

        {/*
         * The second column: whatever the page underneath put in it.
         *
         * Kept mounted while empty and while collapsed. It is the portal's
         * target: destroying it would leave `SidePane` with nowhere to render
         * and no way to find out when there was, and collapsing the chat would
         * throw away a half-typed question.
         */}
        <aside
          className={cn(
            // Bordered along whichever edge it actually meets the page on: a
            // left border under a full-width block is a line to nowhere.
            "no-print w-full shrink-0 border-t bg-card lg:border-l lg:border-t-0",
            "h-[calc(100vh-var(--band))] lg:sticky lg:top-band lg:h-[calc(100vh-var(--band))] lg:self-start",
            // Maximised, it covers the page instead of replacing it: laid over
            // everything under the band, so the document underneath keeps its
            // scroll position and its layout, and putting the pane back is not
            // a re-render of the meeting.
            pane.expanded
              ? "lg:fixed lg:inset-x-0 lg:bottom-0 lg:top-band lg:z-30 lg:h-auto lg:w-auto"
              : "lg:w-[var(--side-pane-w)]",
            showPane ? "relative flex flex-col" : "hidden",
          )}
        >
          <div id={SIDE_PANE_ID} className="flex min-h-0 flex-1 flex-col" />
        </aside>
      </div>

      <MobileTabs pathname={pathname} create={chrome.create} recording={capturing} />

      <SearchCommand
        open={searching.open}
        initial={searching.initial}
        onOpenChange={(next) => (next ? openSearch() : closeSearch())}
      />
      {/* Opened from the band, and finished with before anybody navigates away.
          It files into the folder the page is inside, which is why the shell
          rather than the dialog reads the pathname. */}
      <ImportDialog open={importing} onOpenChange={setImporting} projectId={chrome.folderId} />
      {/* Rendered by the shell, not the record page, for the same reason the
          recorder is: it has to survive the navigation it is telling you is
          safe to make. Renders nothing when there is no recording. */}
      <RecordingBar />
      {/* Beside it, and for the same reason: the pipeline outlives the page
          that started it, so what reports on it has to outlive that page too.
          Renders nothing when this tab is watching no jobs. */}
      <ProcessingDock />
    </div>
  );
}
