"use client";

/**
 * The bottom tabs — navigation on a phone, and the fourth is Record.
 *
 * <h2>What this replaced</h2>
 *
 * <p>A hamburger that slid the whole 256px desktop rail in over a scrim. Three
 * problems with that, and the third is the one that mattered: it put navigation
 * behind a gesture, it reached the top-left corner of the screen — the furthest
 * point from a thumb — and it showed a folder tree, an allowance meter and an
 * account button to somebody who wanted to get to the chat.
 *
 * <p>Tabs are the platform convention on a phone because they are the only
 * arrangement where the destinations are visible without being opened and are
 * where the hand already is. The same three words as the band, in the same
 * order, so the app has one navigation with two shapes rather than two
 * navigations.
 *
 * <h2>Why Record is here and Search is not</h2>
 *
 * <p>Record is a fourth tab rather than a fifth control in the band because a
 * phone is the device most likely to be the recorder — it is the thing on the
 * table — and because a filled pill in a 48px band beside four icons is what a
 * thumb hits by accident. Search stays in the band: it opens a full-screen
 * sheet either way, so its position costs nothing, and a magnifier among three
 * destinations is the classic way to make a tab bar mean two things.
 *
 * <h2>It floats above the recording bar rather than under it</h2>
 *
 * <p>Both are fixed to the bottom. `--recording-bar` is published by the bar
 * itself and is zero when there is no recording, so this sits on the bottom
 * edge normally and lifts by exactly the bar's height while one is running —
 * measured rather than guessed, because that bar is not one height.
 */

import * as React from "react";
import Link from "next/link";
import { Library as LibraryIcon, Mic, Home, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ASK, HOME, LIBRARY } from "@/lib/routes";
import { placeFor, type PlaceId } from "@/lib/places";
import { useStartRecording } from "@/components/v2/record-action";

const TABS: { id: PlaceId; href: string; label: string; icon: typeof Home }[] = [
  { id: "now", href: HOME, label: "Now", icon: Home },
  { id: "library", href: LIBRARY, label: "Library", icon: LibraryIcon },
  { id: "ask", href: ASK, label: "Ask", icon: Sparkles },
];

export function MobileTabs({
  pathname,
  create,
  recording,
}: {
  pathname: string;
  /** Whether Record is offered. Withheld while one is in hand. */
  create: boolean;
  /** Whether the recorder is holding anything. Lights the Record tab. */
  recording: boolean;
}) {
  const record = useStartRecording(pathname);
  const here = placeFor(pathname);

  return (
    <nav
      aria-label="Places"
      className="v2-band no-print fixed inset-x-0 z-40 flex h-tabbar items-stretch md:hidden"
      style={{ bottom: "var(--recording-bar, 0px)" }}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        // Inside a meeting, Library is still lit. Icons in a tab bar are always
        // lit for *something* — a bar where nothing is selected reads as one
        // that has lost track of where you are.
        const on = here.id === tab.id;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={on && !here.nested ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-press ease-soft",
              on ? "text-ink" : "text-ink-4",
            )}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={on ? 2.1 : 1.7} />
            <span className={cn(on && !here.nested && "font-headline")}>{tab.label}</span>
          </Link>
        );
      })}

      {/* The fourth. Not a destination, and drawn as one anyway: a tab bar with
          three even columns and a floating button over the top of it is two
          controls fighting for the same corner, and the button always wins the
          fight and loses the label. */}
      <button
        type="button"
        onClick={record.start}
        disabled={!create}
        title={record.refusal ?? undefined}
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-press ease-soft",
          // Withheld, not hidden, while one is running: the column disappearing
          // would move the other three under a thumb that is already moving.
          // What it says instead is that a recording is already happening.
          recording ? "text-danger" : create ? "text-ink-4" : "text-ink-5",
        )}
      >
        <Mic className="h-[18px] w-[18px]" strokeWidth={1.7} />
        <span>{recording ? "Recording" : "Record"}</span>
      </button>
    </nav>
  );
}
