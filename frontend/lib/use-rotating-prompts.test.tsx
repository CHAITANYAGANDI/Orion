import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { resetPromptRotation, useRotatingPrompts } from "@/lib/use-rotating-prompts";
import { SUGGESTION_ROW, type ChatPrompt } from "@/lib/chat-prompts";

/**
 * Three chips, and a different three next time.
 *
 * The row was neither. `toPrompts` returned the whole hand-written list when
 * nothing had been generated — seven chips on a meeting still processing — and
 * a meeting's generated questions are made once, at processing time, so the
 * three that did show never changed for the life of the meeting.
 */

function pool(n: number): ChatPrompt[] {
  return Array.from({ length: n }, (_, i) => ({ label: `q${i}`, prompt: `q${i}` }));
}

function Row({ surface, size, rotateOn }: { surface: string; size: number; rotateOn?: unknown }) {
  const prompts = useRotatingPrompts(surface, pool(size), rotateOn ?? null);
  return <p data-testid="row">{prompts.map((p) => p.label).join(" ")}</p>;
}

/** Mount, read the row, unmount — one visit to a surface. */
function visit(surface: string, size = 9, rotateOn?: unknown): string {
  render(<Row surface={surface} size={size} rotateOn={rotateOn} />);
  const row = screen.getByTestId("row").textContent ?? "";
  cleanup();
  return row;
}

beforeEach(() => {
  resetPromptRotation();
});

describe("how many", () => {
  it("shows three, whatever the pool holds", () => {
    for (const size of [4, 7, 9, 20]) {
      resetPromptRotation();
      expect(visit("home", size).split(" ")).toHaveLength(SUGGESTION_ROW);
    }
  });

  it("shows a short pool whole rather than repeating a chip to reach three", () => {
    // Wrapping a pool of two would deal q0 q1 q0, which looks like a bug
    // because it is one.
    expect(visit("home", 2)).toBe("q0 q1");
    expect(visit("home", 1)).toBe("q0");
  });

  it("shows nothing when there is nothing", () => {
    expect(visit("home", 0)).toBe("");
  });
});

describe("rotation", () => {
  it("deals a different row on the next visit", () => {
    const first = visit("home");
    const second = visit("home");

    expect(second).not.toBe(first);
  });

  it("works through the pool before repeating", () => {
    const rows = [visit("home"), visit("home"), visit("home")];

    // Nine questions, three at a time: three visits should be nine distinct
    // chips, not the same one coming round early.
    expect(new Set(rows.join(" ").split(" ")).size).toBe(9);
  });

  it("comes back to the top once the pool is spent", () => {
    const first = visit("home");
    visit("home");
    visit("home");

    expect(visit("home")).toBe(first);
  });

  it("starts every surface at the best questions", () => {
    // The pool is ordered best-first, so a reader who only ever visits once
    // must get the strongest three rather than an arbitrary window.
    expect(visit("home")).toBe("q0 q1 q2");
  });

  it("does not move the row while it is on screen", () => {
    // A chip that changes under the cursor is worse than one already seen.
    const { rerender } = render(<Row surface="home" size={9} />);
    const before = screen.getByTestId("row").textContent;

    rerender(<Row surface="home" size={9} />);

    expect(screen.getByTestId("row").textContent).toBe(before);
  });

  it("deals a fresh row when a new chat starts", () => {
    const { rerender } = render(<Row surface="home" size={9} rotateOn="cnv_1" />);
    const before = screen.getByTestId("row").textContent;

    // Pressing New chat: the conversation id changes while the surface stays
    // mounted, which is the one moment the row should move underneath you.
    rerender(<Row surface="home" size={9} rotateOn="cnv_2" />);

    expect(screen.getByTestId("row").textContent).not.toBe(before);
  });
});

describe("one offset per surface", () => {
  it("does not deal the rail the row the full page just used", () => {
    const home = visit("home");
    const ask = visit("ask");

    // Home and /ask draw from the same pool and are two screens. Sharing a
    // counter would mean opening one and then the other showed the second row
    // on a chat that had never offered a first.
    expect(ask).toBe(home);
  });

  it("keeps two meetings' rotations apart", () => {
    visit("mtg_a");
    visit("mtg_a");

    // A meeting opened for the first time starts at the top of its own pool,
    // however much another meeting has been read.
    expect(visit("mtg_b")).toBe("q0 q1 q2");
  });

  it("carries on where a surface left off", () => {
    visit("mtg_a");
    visit("mtg_b");

    expect(visit("mtg_a")).toBe("q3 q4 q5");
  });
});
