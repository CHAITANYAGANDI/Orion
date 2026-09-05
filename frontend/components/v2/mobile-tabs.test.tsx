import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Navigation on a phone.
 *
 * <p>What this replaced was a hamburger that slid the entire desktop rail in
 * over a scrim — navigation behind a gesture, in the corner furthest from a
 * thumb, showing a folder tree and an allowance meter to somebody who wanted to
 * get to the chat.
 *
 * <p>Which makes the risk here specific: mobile navigation is the half of a
 * redesign nobody checks, and a phone that has lost its way to Library or its
 * way to Record has lost the product. So the same census as the band, plus the
 * one thing only this component has to get right — that it is the same
 * navigation as the band rather than a second one that can drift.
 */
const { push, start, setReturnTo, toastError } = vi.hoisted(() => ({
  push: vi.fn(),
  start: vi.fn(),
  setReturnTo: vi.fn(),
  toastError: vi.fn(),
}));

let recorderState: "idle" | "recording";
let refusal: string | null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/home",
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/lib/recording-context", () => ({
  useRecording: () => ({ state: recorderState, start }),
  useRecordingSession: () => ({ setReturnTo }),
}));
vi.mock("@/lib/allowance", () => ({
  useAllowance: () => ({}),
  recordRefusal: () => refusal,
}));

import { MobileTabs } from "@/components/v2/mobile-tabs";

function tabs(over: Partial<React.ComponentProps<typeof MobileTabs>> = {}) {
  return render(<MobileTabs pathname="/home" create recording={false} {...over} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  recorderState = "idle";
  refusal = null;
});

describe("the destinations", () => {
  it("are the same three as the band, in the same order", () => {
    // One navigation with two shapes, not two navigations. A phone that offers
    // a different set of places is a second information architecture nobody
    // maintains.
    tabs();

    const names = screen.getAllByRole("link").map((el) => el.textContent);
    expect(names).toEqual(["Now", "Library", "Ask"]);
  });

  it("go where the band's do", () => {
    tabs();

    expect(screen.getByRole("link", { name: "Now" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("link", { name: "Ask" })).toHaveAttribute("href", "/ask");
  });

  it("mark where you are", () => {
    tabs({ pathname: "/ask" });

    expect(screen.getByRole("link", { name: "Ask" })).toHaveAttribute("aria-current", "page");
  });

  it("do not claim to be the page one level down", () => {
    tabs({ pathname: "/meetings/mtg_1" });

    expect(screen.getByRole("link", { name: "Library" })).not.toHaveAttribute("aria-current");
  });
});

describe("Record, which is the fourth", () => {
  it("starts a recording rather than navigating on its own", async () => {
    tabs({ pathname: "/folder/prj_1" });

    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    // Identical to the band's, because both call the same hook. Two copies of
    // this drift, and the copy that drifts is the one on the phone.
    expect(push).toHaveBeenCalledWith("/record?r=%2Ffolder%2Fprj_1");
    expect(setReturnTo).toHaveBeenCalledWith("/folder/prj_1");
    expect(start).toHaveBeenCalled();
  });

  it("explains a refusal instead of opening the microphone", async () => {
    refusal = "You have used your 100 minutes.";
    tabs();

    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(toastError).toHaveBeenCalledWith("You have used your 100 minutes.");
    expect(push).not.toHaveBeenCalled();
  });

  it("says a recording is running rather than disappearing", async () => {
    // The column vanishing would move the other three under a thumb that is
    // already moving. It stands down in place and says why.
    tabs({ create: false, recording: true });

    const button = screen.getByRole("button", { name: "Recording" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
  });

  it("keeps the three destinations reachable while one is running", () => {
    // The whole reason the recorder survives navigation is so somebody can go
    // and look something up mid-meeting.
    tabs({ create: false, recording: true });

    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});

describe("where it sits", () => {
  it("lifts above the recording bar rather than under it", () => {
    // Both are fixed to the bottom. `--recording-bar` is published by the bar
    // itself and is zero when there is none, so this sits on the bottom edge
    // normally and lifts by exactly the bar's height while one runs — measured
    // rather than guessed, because that bar is not one height.
    const { container } = tabs();

    expect(container.querySelector("nav")).toHaveStyle({ bottom: "var(--recording-bar, 0px)" });
  });
});
