"use client";

/**
 * THE BAND — forty-eight pixels, and the whole of the permanent chrome.
 *
 * <h2>What it replaced</h2>
 *
 * <p>A 256px navigation rail down the left and a 64px header across the top:
 * 320px of chrome on a 1440px screen, 22% of it, present on every page whether
 * or not anything in it was wanted. The rail held two links, a folder tree, a
 * bell, an allowance meter and an account button — six things, of which the two
 * links were the navigation. The header held global actions and the page's own
 * actions in one row, which is why it needed a rulebook (lib/chrome.ts) to stop
 * them colliding.
 *
 * <p>This is one row, 48px, and it is the same row on every page. Left: the
 * mark and three words. Right: Search, Import, Record, notifications, you.
 * Nothing here belongs to the page underneath — page actions live in the page,
 * beside the thing they act on — which is what makes a fixed shape possible and
 * what makes the rulebook unnecessary.
 *
 * <h2>Glass, once</h2>
 *
 * <p>The band is the functional layer above content, which is the only thing
 * translucency is for in this product. It is never nested inside another glass
 * surface and content never uses it. See `.v2-band` in app/globals.css.
 *
 * <h2>While recording, the band is the state</h2>
 *
 * <p>It turns rather than gaining a pill beside everything else. There was a
 * live-recording pill in the old header and it was removed for a reason that
 * still holds: the docked bar along the bottom carries the waveform, the clock
 * and the two buttons that end the recording, so a second statement of the same
 * fact was a smaller copy of a thing already on screen. What the band adds is
 * ambient rather than duplicated — you cannot look at any page without seeing
 * that the chrome has changed colour.
 */

import * as React from "react";
import Link from "next/link";
import { Download, Mic, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { HOME } from "@/lib/routes";
import { openSearch } from "@/lib/search-overlay";
import { BrandMark } from "@/components/v2/brand-mark";
import { Places } from "@/components/v2/places";
import { useStartRecording } from "@/components/v2/record-action";
import { NotificationBell } from "@/components/notification-bell";
import { AccountMenu } from "@/components/account-menu";

export interface AppBandProps {
  pathname: string;
  /** Whether Import and Record are offered. See `bandChrome` in lib/chrome.ts. */
  create: boolean;
  /** Whether the recorder is holding anything. Turns the band. */
  recording: boolean;
  onImport: () => void;
}

export function AppBand({ pathname, create, recording, onImport }: AppBandProps) {
  const record = useStartRecording(pathname);

  return (
    <header
      /*
       * Fixed rather than sticky. Sticky needs one scrolling ancestor and this
       * app has several — a transcript scrolls itself, the side pane scrolls
       * itself, and a page that is shorter than the window scrolls nothing at
       * all. Fixed is the same result under every one of those.
       */
      className="v2-band no-print fixed inset-x-0 top-0 z-40 h-band"
      data-recording={recording ? "true" : undefined}
    >
      <div className="flex h-full items-center gap-1 pl-3 pr-2 sm:pl-4 sm:pr-3">
        {/* The mark goes home, which is the one thing a logo in a corner has
            meant for as long as there have been corners. Not a place in the
            row of three: it is the same destination as Now, and a nav with
            two ways to the same page teaches people that one of them is
            something else. */}
        <Link
          href={HOME}
          aria-label="Reverie — home"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink opacity-90 transition-opacity duration-press ease-soft hover:opacity-100"
        >
          <BrandMark size={18} />
        </Link>

        {/* Below `md` these are the bottom tabs instead. Three words plus five
            controls do not fit across a phone, and navigation is the half that
            is easier to reach with a thumb at the bottom. See
            components/v2/mobile-tabs.tsx. */}
        <Places pathname={pathname} className="ml-1 hidden md:flex" />

        <div className="flex-1" />

        <FindButton />

        {create && (
          <>
            {/* Down: into Reverie. The pair with Export's up arrow — read from
                the app's side, not the device's, so the two point at each
                other rather than both meaning "file transfer".

                A dialog rather than a route: a file arrives more often than
                anything else creates a meeting, and it should not cost leaving
                whatever is on screen. /upload still exists for the fuller form
                — filing straight into a folder — and for direct links. */}
            <BandIcon label="Import a recording" onClick={onImport}>
              <Download className="h-4 w-4" />
            </BandIcon>

            {/* The one filled control in the band, and the only one that is not
                an icon. Hidden on a phone, where it is the fourth bottom tab —
                a red pill in a 48px band beside four other controls is the
                first thing a thumb hits by accident. */}
            <button
              type="button"
              onClick={record.start}
              // Not disabled: a dead button explains nothing, and the reason is
              // the whole of what somebody needs here. It stays pressable and
              // answers.
              title={record.refusal ?? undefined}
              className={cn(
                "hidden h-8 shrink-0 items-center gap-1.5 rounded-full bg-brand-fill pl-2.5 pr-3.5 text-foot font-headline text-white md:flex",
                "transition-colors duration-press ease-soft hover:bg-brand-hover",
              )}
            >
              <Mic className="h-3.5 w-3.5" />
              Record
            </button>
          </>
        )}

        {/* Drawn only when there is something on both sides of it. Without the
            create controls the two remaining icons are the same kind of thing —
            things that are about you rather than about the work — and a stroke
            with nothing to separate is a stroke floating in a row. */}
        {create && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />}

        <NotificationBell />
        <AccountMenu />
      </div>
    </header>
  );
}

/**
 * Search, which is not an input.
 *
 * <p>Clicking it opens the real one, which needs the whole width of the screen
 * for its results — an inline box that grew a dropdown on focus would have to
 * fight the band for room and would lose on a laptop. ⌘K works everywhere
 * regardless; the shortcut is bound on the shell.
 *
 * <p>It is on every page now. The old rule stripped it on Account Settings, on
 * the grounds that search finds meetings and there are none on those pages —
 * true, and it made the header change shape on the one navigation people make
 * most deliberately. In a band that is otherwise identical everywhere, the
 * missing control reads as a fault. See lib/chrome.ts.
 */
function FindButton() {
  return (
    <button
      type="button"
      onClick={() => openSearch()}
      aria-label="Search"
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-2.5 text-foot text-ink-3",
        "transition-colors duration-press ease-soft hover:border-edge-hover hover:text-ink-2",
        "sm:pr-2",
      )}
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="hidden sm:inline">Search</span>
      {/* The shortcut, shown rather than taught. Mono because it is a key, and
          hidden where it cannot be pressed. */}
      <kbd className="hidden rounded-xs border border-line px-1 font-mono text-[10px] leading-4 text-ink-4 lg:inline">
        ⌘K
      </kbd>
    </button>
  );
}

/** An icon control in the band. 32px, which is the tap target 48px allows for. */
function BandIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors duration-press ease-soft hover:bg-surface-hover hover:text-ink"
    >
      {children}
    </button>
  );
}
