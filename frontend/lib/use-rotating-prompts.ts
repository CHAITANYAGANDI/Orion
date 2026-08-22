"use client";

/**
 * Three chips, and a different three next time.
 *
 * ## What this replaces
 *
 * Two things were wrong with the suggestion row, and they had the same cause.
 *
 * **It was not always three.** `toPrompts` returned the generated questions if
 * there were any and the *whole* hand-written list if there were not — seven
 * chips on a meeting still processing, six on a new workspace. Three is the
 * design: they sit directly above the composer, and a fourth pushes the box
 * down and turns a set of examples into a menu you have to read.
 *
 * **It never changed.** A meeting's suggestions are generated once, when it is
 * processed, and stored with the summary. So the same three questions sat above
 * the composer on every visit for the life of the meeting, and a row you have
 * already read twice is a row you stop seeing.
 *
 * Both follow from the row and the pool being the same list. They are separated
 * now: the service returns everything worth asking, best first, and this takes
 * three off it and moves the window along.
 *
 * ## Why rotation rather than regeneration
 *
 * The obvious way to make chips change is to ask the model for three new ones.
 * That is a model call every time somebody opens a page — on the one part of
 * the UI that is decoration, and on every surface at once. Generating a pool of
 * eight instead of three costs nothing: it is the same single call with a
 * larger number in it, made once and cached.
 *
 * ## When the window moves
 *
 * On arriving at the surface, and whenever `rotateOn` changes — which callers
 * pass as the conversation id, so pressing New chat deals a fresh row.
 *
 * Deliberately **not** while you are looking at it. The offset is read during
 * render and advanced in an effect, so the row you can see is stable and the
 * *next* one differs. A chip that moves under the cursor is worse than a chip
 * you have seen before.
 *
 * The offsets live in a module-level map, like `lib/active-chat`: they outlive
 * a render, they are per surface, and a reload starts everyone at the top of
 * the pool, which is where the best questions are.
 */

import * as React from "react";
import { SUGGESTION_ROW, type ChatPrompt } from "@/lib/chat-prompts";

/** Surface key -> where in its pool the next row starts. */
const offsets = new Map<string, number>();

/** Forget every offset. Exists so tests start from the top of the pool. */
export function resetPromptRotation(): void {
  offsets.clear();
}

/**
 * @param key      which surface is asking — "home", "ask", or a meeting id
 * @param pool     every question this chat could offer, best first
 * @param rotateOn changes when a fresh row is due; normally the conversation id
 */
export function useRotatingPrompts(
  key: string,
  pool: ChatPrompt[],
  rotateOn: unknown,
): ChatPrompt[] {
  // The window this mount claimed, pinned. Reading the shared counter on every
  // render instead would move the row whenever anything above re-rendered —
  // a message arriving, a keystroke in the composer — which is the one thing
  // rotation must not do.
  const offset = React.useRef<number | null>(null);
  const rotated = React.useRef<unknown>(rotateOn);

  if (offset.current === null) {
    offset.current = offsets.get(key) ?? 0;
  } else if (!Object.is(rotated.current, rotateOn)) {
    // A new chat, while the surface stayed mounted. The effect below has
    // already advanced the counter, so this reads the next window along.
    rotated.current = rotateOn;
    offset.current = offsets.get(key) ?? 0;
  }

  React.useEffect(() => {
    // Advance for next time, not for now — and here rather than in render, so
    // the only writer runs after the row is on screen.
    offsets.set(key, (offsets.get(key) ?? 0) + SUGGESTION_ROW);
  }, [key, rotateOn]);

  const start = offset.current;
  return React.useMemo(() => window(pool, start), [pool, start]);
}

/**
 * `SUGGESTION_ROW` chips starting at `offset`, wrapping round.
 *
 * A pool no bigger than the row is returned whole rather than wrapped — a pool
 * of two would otherwise repeat a chip to reach three, which looks like a bug
 * and is one.
 */
function window(pool: ChatPrompt[], offset: number): ChatPrompt[] {
  if (pool.length <= SUGGESTION_ROW) return pool;
  const out: ChatPrompt[] = [];
  for (let i = 0; i < SUGGESTION_ROW; i += 1) {
    out.push(pool[(offset + i) % pool.length]);
  }
  return out;
}
