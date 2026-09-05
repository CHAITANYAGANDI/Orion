import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";

/**
 * START RECORDING → NAVIGATE → THE RECORDING STILL EXISTS.
 *
 * <h2>Why this is its own file, and why it uses the real provider</h2>
 *
 * <p>This is the regression the whole recording architecture exists to prevent,
 * and it is the one the V2 shell rewrite was most likely to reintroduce.
 *
 * <p>`useRecorder` tears down its streams when the component holding it
 * unmounts. While that hook lived on the record page, a client-side navigation
 * destroyed a live recording: clicking any link unmounted the page, stopped the
 * microphone, and dropped every chunk captured so far. **Nothing failed
 * loudly** — the recording simply ceased to exist, and the user found out when
 * they came back to a reset page.
 *
 * <p>The fix was to hoist the provider above the router, into the app-group
 * layout that stays mounted across every in-app route change. Which means the
 * property being defended is *structural*, not behavioural: the provider must
 * not be remounted. No amount of testing `useRecorder` in isolation can see
 * that, and neither can the shell's own test file, which mocks the provider out
 * to a passthrough.
 *
 * <p>So this file mocks nothing about the provider. It counts mounts of the
 * real `RecordingProvider` and drives a real route change through the real
 * `AppShell`.
 */
const mounts = vi.hoisted(() => ({ recorder: 0, transcript: 0, saveJob: 0 }));

let pathname: string;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => pathname,
}));

/*
 * The three hooks the provider owns, counted rather than replaced in spirit.
 *
 * Each returns a stable object and increments a counter on mount. A remount is
 * the failure: it means React tore the provider down and built a new one, which
 * in production is a microphone closing and a buffer of audio being freed.
 */
vi.mock("@/lib/use-recorder", () => ({
  useRecorder: () => {
    React.useEffect(() => {
      mounts.recorder += 1;
    }, []);
    return {
      state: "recording",
      elapsed: 42,
      startedAt: new Date("2026-08-14T09:00:00Z"),
      level: 0.4,
      silentSeconds: 0,
      error: null,
      result: null,
      supported: true,
      devices: [],
      deviceId: null,
      setDeviceId: vi.fn(),
      liveSource: null,
      start: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
    };
  },
}));
vi.mock("@/lib/use-live-transcript", () => ({
  useLiveTranscript: () => {
    React.useEffect(() => {
      mounts.transcript += 1;
    }, []);
    return {
      supported: true,
      status: "listening",
      turns: [],
      pending: null,
      error: null,
      reconnects: 0,
      clear: vi.fn(),
    };
  },
}));
vi.mock("@/lib/use-save-job", () => ({
  useSaveJob: () => {
    React.useEffect(() => {
      mounts.saveJob += 1;
    }, []);
    return {
      phase: "idle",
      job: null,
      busy: false,
      stopping: false,
      save: vi.fn(),
      stop: vi.fn(),
      dismiss: vi.fn(),
    };
  },
}));

// Everything the shell mounts that is not the recorder. None of it is the
// subject; all of it would drag the API layer in.
vi.mock("@/components/v2/app-band", () => ({ AppBand: () => <header /> }));
vi.mock("@/components/v2/mobile-tabs", () => ({ MobileTabs: () => <nav /> }));
vi.mock("@/components/search-command", () => ({ SearchCommand: () => null }));
vi.mock("@/components/import-dialog", () => ({ ImportDialog: () => null }));
vi.mock("@/components/processing-dock", () => ({ ProcessingDock: () => null }));
vi.mock("@/components/folder-header-actions", () => ({ FolderHeaderActions: () => null }));
/*
 * Stands in for the docked bar, reporting the one thing this file is about:
 * that the recorder it reads is still the same live one after a navigation.
 *
 * An ASYNC factory, because it needs the real `useRecording` and a `vi.mock`
 * factory is hoisted above every import in the file. `require` is not available
 * here either -- this runs as ESM.
 */
vi.mock("@/components/recording-bar", async () => {
  const { useRecording } = await import("@/lib/recording-context");
  return {
    RecordingBar: () => <div data-testid="bar">{useRecording().state}</div>,
  };
});

import { AppShell } from "@/components/app-shell";

/** Two different pages, so a route change is a real change of children. */
function Page({ name }: { name: string }) {
  return <p>{name}</p>;
}

beforeEach(() => {
  mounts.recorder = 0;
  mounts.transcript = 0;
  mounts.saveJob = 0;
  pathname = "/record";
});

describe("a recording in progress", () => {
  it("survives navigating to another route", () => {
    const view = render(
      <AppShell>
        <Page name="the record page" />
      </AppShell>,
    );
    expect(mounts.recorder).toBe(1);
    expect(screen.getByTestId("bar")).toHaveTextContent("recording");

    // A client-side navigation: the pathname changes and the page under the
    // shell is replaced. This is what used to end the recording.
    act(() => {
      pathname = "/library";
    });
    view.rerender(
      <AppShell>
        <Page name="the library" />
      </AppShell>,
    );

    expect(screen.getByText("the library")).toBeInTheDocument();
    // THE assertion. One mount, still.
    expect(mounts.recorder).toBe(1);
    expect(screen.getByTestId("bar")).toHaveTextContent("recording");
  });

  it("survives a route with a side pane and one without", () => {
    // The shell renders a different subtree depending on whether the page has
    // filled the pane. If the provider sat inside that subtree, opening or
    // closing it would end the recording.
    const view = render(
      <AppShell>
        <Page name="now" />
      </AppShell>,
    );

    act(() => {
      pathname = "/meetings/mtg_1";
    });
    view.rerender(
      <AppShell>
        <Page name="a meeting" />
      </AppShell>,
    );

    expect(mounts.recorder).toBe(1);
  });

  it("does not rebuild the live transcript or the save job either", () => {
    // The transcript holds the speaker model built up over the meeting so far,
    // and the save job holds an upload. Both are in the same provider and both
    // would be lost by a remount — the recorder is simply the loudest of the
    // three.
    const view = render(
      <AppShell>
        <Page name="now" />
      </AppShell>,
    );

    act(() => {
      pathname = "/ask";
    });
    view.rerender(
      <AppShell>
        <Page name="ask" />
      </AppShell>,
    );

    expect(mounts.transcript).toBe(1);
    expect(mounts.saveJob).toBe(1);
  });

  it("keeps the docked bar on every route, which is how you get back", () => {
    // The bar is the whole of the recording's presence away from /record: it
    // pauses, it stops, it shows the clock, and it carries the way back to the
    // page. Rendered by the shell rather than by any page, for exactly that
    // reason.
    pathname = "/settings/plans";
    render(
      <AppShell>
        <Page name="settings" />
      </AppShell>,
    );

    expect(screen.getByTestId("bar")).toHaveTextContent("recording");
  });
});
