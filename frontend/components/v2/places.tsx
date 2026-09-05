"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { ASK, HOME, LIBRARY, placeFor, type PlaceId } from "@/lib/places";

/*
 * THE PLACES — three words, and that is the whole of navigation.
 *
 * Where you are is stated in a word rather than inferred from a lit icon in a
 * column, and the highlight is a 2px underline sitting on the band's own bottom
 * edge — a boundary the layout already has, so the active state costs no filled
 * rectangle and no extra chrome.
 *
 * A PARENT PLACE gets a dimmer underline: standing inside a folder or a
 * meeting, Library is not where you are but it is where you came from, and a
 * navigation that goes blank one level down makes people feel lost.
 *
 * Three, and the third is Ask. Record, Import and Search are deliberately not
 * here — they are verbs, and putting them in a row of destinations is what
 * makes a nav look symmetrical and behave wrongly.
 */

const PLACES: { id: PlaceId; href: string; label: string }[] = [
  { id: "now", href: HOME, label: "Now" },
  { id: "library", href: LIBRARY, label: "Library" },
  { id: "ask", href: ASK, label: "Ask" },
];

export function Places({
  pathname,
  className,
  onNavigate,
}: {
  pathname: string;
  className?: string;
  onNavigate?: () => void;
}) {
  const here = placeFor(pathname);

  return (
    <nav aria-label="Places" className={cn("flex items-center", className)}>
      {PLACES.map((place) => {
        const current = here.id === place.id && !here.nested;
        const parent = here.id === place.id && here.nested;
        return (
          <Link
            key={place.id}
            href={place.href}
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            data-parent={parent ? "" : undefined}
            className={cn(
              "relative flex h-band items-center px-[11px] text-body transition-colors duration-press ease-soft",
              "after:absolute after:inset-x-[11px] after:bottom-0 after:h-[2px] after:rounded-t-[1px] after:content-['']",
              current
                ? "font-headline text-ink after:bg-ink"
                : parent
                  ? "text-ink-3 after:bg-ink-5 hover:text-ink-2"
                  : "text-ink-3 after:bg-transparent hover:text-ink-2",
            )}
          >
            {place.label}
          </Link>
        );
      })}
    </nav>
  );
}
