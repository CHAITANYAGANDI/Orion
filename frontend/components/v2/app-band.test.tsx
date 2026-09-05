import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The band — forty-eight pixels, and the whole of the permanent chrome.
 *
 * <p>It replaced a 256px rail and a 64px header, so the risk it carries is not
 * that it looks wrong. It is that something the rail held was quietly dropped
 * in the move: the bell, the account, the way to Import, the way to Record. A
 * control that is gone from a redesign does not fail loudly — it is simply
 * never found again.
 *
 * <p>So this file is a census. Everything that has to be reachable from every
 * page is asserted to be reachable, and the one rule that takes anything away
 * is asserted to take it away for the right reason.
 */
const { push, start, setReturnTo, toastError } = vi.hoisted(() => ({
  push: vi.fn(),
  start: vi.fn(),
  setReturnTo: vi.fn(),
  toastError: vi.fn(),
}));

/** What the recorder is holding, and whether the account may record at all. */
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

// The two ends of the band draw their own data. Neither is what this file is
// about, and both would drag the whole API layer in with them.
vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));
vi.mock("@/components/account-menu", () => ({
  AccountMenu: () => <button type="button">Priya Raman</button>,
}));

import { AppBand } from "@/components/v2/app-band";
import { openSearch, resetSearchOverlay, useSearchOverlay } from "@/lib/search-overlay";

/**
 * Reads the store the way the shell does.
 *
 * <p>The overlay is a module store rather than component state, precisely so
 * that something three components deep can open it. There is no `getState` to
 * peek at, and there should not be — so the test subscribes the same way the
 * real subscriber does.
 */
function Probe() {
  const overlay = useSearchOverlay();
  return <p data-testid="overlay">{overlay.open ? `open:${overlay.initial}` : "closed"}</p>;
}

function band(over: Partial<React.ComponentProps<typeof AppBand>> = {}) {
  return render(
    <>
      <AppBand pathname="/home" create recording={false} onImport={() => {}} {...over} />
      <Probe />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSearchOverlay();
  recorderState = "idle";
  refusal = null;
});

describe("what is always there", () => {
  it("carries the three places", () => {
    band();

    const nav = screen.getByRole("navigation", { name: "Places" });
    const names = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
    expect(names).toEqual(["Now", "Library", "Ask"]);
  });

  it("sends each place to its own page", () => {
    band();

    expect(screen.getByRole("link", { name: "Now" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library");
    expect(screen.getByRole("link", { name: "Ask" })).toHaveAttribute("href", "/ask");
  });

  it("takes the mark home", () => {
    // The one thing a logo in a corner has meant for as long as there have
    // been corners.
    band();

    expect(screen.getByRole("link", { name: /Reverie/ })).toHaveAttribute("href", "/home");
  });

  it("keeps the bell and the account, which the rail used to hold", () => {
    band();

    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Priya Raman" })).toBeInTheDocument();
  });

  it("opens search", async () => {
    band();
    expect(screen.getByTestId("overlay")).toHaveTextContent("closed");

    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByTestId("overlay")).toHaveTextContent("open:");
  });

  it("offers search on Account Settings too", () => {
    // The old header stripped it there, on the grounds that search finds
    // meetings and settings pages have none. True, and it made the chrome
    // change shape on one of the most deliberate navigations in the app —
    // which in a band that is otherwise identical everywhere reads as a fault.
    band({ pathname: "/settings/plans" });

    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
});

describe("marking where you are", () => {
  it("marks the place you are on, and only that one", () => {
    band({ pathname: "/library" });

    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Now" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Ask" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the parent marked one level down, without claiming to be it", () => {
    // Inside a meeting, Library is where you came from. Claiming `aria-current`
    // would be a lie about which page this is; marking nothing at all is a
    // navigation that goes blank exactly where people spend most of their time.
    band({ pathname: "/meetings/mtg_1" });

    const library = screen.getByRole("link", { name: "Library" });
    expect(library).not.toHaveAttribute("aria-current");
    expect(library).toHaveAttribute("data-parent");
  });

  it("marks nothing on a page that is not a place", () => {
    band({ pathname: "/record" });

    for (const name of ["Now", "Library", "Ask"]) {
      expect(screen.getByRole("link", { name })).not.toHaveAttribute("aria-current");
    }
  });
});

describe("Import and Record", () => {
  it("offers both when there is nothing in hand", () => {
    band();

    expect(screen.getByRole("button", { name: "Import a recording" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  });

  it("opens the import dialog rather than navigating", async () => {
    // A file arrives more often than anything else creates a meeting, and it
    // should not cost leaving whatever is on screen.
    const onImport = vi.fn();
    band({ onImport });

    await userEvent.click(screen.getByRole("button", { name: "Import a recording" }));

    expect(onImport).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("withholds both while a recording is in hand", () => {
    // The rule with a consequence rather than an opinion. Record would be
    // offering to start what is already running, and Import would be a file
    // picker over a live microphone.
    band({ create: false, recording: true });

    expect(screen.queryByRole("button", { name: "Import a recording" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
  });

  it("goes to /record carrying the page it was pressed on", async () => {
    band({ pathname: "/folder/prj_1" });

    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    // The folder has to survive: by save time the pathname is /record, and
    // "which folder am I in" has no answer.
    expect(push).toHaveBeenCalledWith("/record?r=%2Ffolder%2Fprj_1");
    expect(setReturnTo).toHaveBeenCalledWith("/folder/prj_1");
    expect(start).toHaveBeenCalled();
  });

  it("explains a refusal instead of opening the microphone", async () => {
    // Checked here as well as on /record, because this is where the microphone
    // is actually opened. Navigating first would put the browser's permission
    // prompt in front of somebody about to be told they cannot record anyway.
    refusal = "You have used your 100 minutes.";
    band();

    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(toastError).toHaveBeenCalledWith("You have used your 100 minutes.");
    expect(push).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("says why, rather than going dead", () => {
    // A disabled button explains nothing, and the reason is the whole of what
    // somebody needs here.
    refusal = "You have used your 100 minutes.";
    band();

    const button = screen.getByRole("button", { name: "Record" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "You have used your 100 minutes.");
  });
});

describe("while recording", () => {
  it("turns, rather than growing a pill beside everything else", () => {
    // The docked bar at the bottom carries the waveform, the clock and the two
    // buttons that end the recording. A second statement of the same fact up
    // here was a smaller copy of a thing already on screen; what the band adds
    // is ambient — you cannot look at any page without seeing it.
    const { container } = band({ create: false, recording: true });

    expect(container.querySelector("header")).toHaveAttribute("data-recording", "true");
  });

  it("is unmarked when nothing is being recorded", () => {
    const { container } = band();

    expect(container.querySelector("header")).not.toHaveAttribute("data-recording");
  });
});

describe("the search store", () => {
  it("is the same one anything else in the app opens", () => {
    // "Search in folder" opens this from a menu three components deep, with a
    // query already in it. A local `useState` in the band could not be reached
    // from there, and the button and the shortcut would drift into two boxes.
    band();

    act(() => openSearch("acme"));

    expect(screen.getByTestId("overlay")).toHaveTextContent("open:acme");
  });
});
