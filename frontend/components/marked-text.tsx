"use client";

import * as React from "react";
import { highlight } from "@/lib/search";

/**
 * The search term, marked inside a result.
 *
 * <p>Shared by the overlay and the results page rather than written out twice.
 * They show the same hits from the same query, and a term marked in one place
 * and not the other reads as one of them having found something different.
 *
 * <p>The escaping that makes this safe on arbitrary input lives in
 * `highlight()` — searching for "(draft)" or "c++" would otherwise throw inside
 * a render, on the one screen whose entire job is accepting typed text.
 */
export function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}
