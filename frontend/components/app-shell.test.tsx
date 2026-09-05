import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The shell, and the eight things it is responsible for.
 *
 * <h2>Why this file exists now and did not before</h2>
 *
 * <p>`app-shell.tsx` had no tests at all, which was survivable while it was a
 * rail and a header that nothing else depended on. It is not survivable through
 * a rewrite: the shell is the only place in the app where the recorder, the
 * processing dock, the search overlay, two portal targets and the import
 * dialog's folder are wired together, and every one of those is a thing that
 * has to outlive a navigation. If the rewrite dropped one, nothing else in the
 * suite would notice — the pages that depend on them each mock the shell away.
 *
 * <p>So this is a wiring test, not a layout test. The band and the bottom tabs
 * have their own files; what is asserted here is that the shell hands them the
 * right state, keeps the portals mounted, and does the things only it can do.
 */
const { push } = vi.hoisted(() => ({ push: vi.fn() }));

let pathname: string;
/** What the recorder is holding. Drives the band, the tabs and the clearance. */
let recorderState: "idle" | "recording";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

vi.mock("@/lib/recording-context", () => ({
  // Kept as a real wrapper rather than a passthrough stub: that it wraps the
  // shell rather than sitting inside it is the reason recording survives a
  // route change, and a stub would let that inversion pass unnoticed.
  RecordingProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="recording-provider">{children}</div>
  ),
  useRecording: () => ({ state: recorderState }),
  useRecordingSession: () => ({ setReturnTo: vi.fn() }),
}));

/*
 * The five things the shell mounts but does not implement. Each is stubbed to
 * report the props the shell decides, which is the whole of the contract
 * between them.
 */
vi.mock("@/components/v2/app-band", () => ({
  AppBand: (props: { pathname: string; create: boolean; recording: boolean; onImport: () => void }) => (
    <header data-testid="band" data-create={String(props.create)} data-recording={String(props.recording)}>
      <button type="button" onClick={props.onImport}>
        Import
      </button>
      <span>{props.pathname}</span>
    </header>
  ),
}));
vi.mock("@/components/v2/mobile-tabs", () => ({
  MobileTabs: (props: { create: boolean; recording: boolean }) => (
    <nav data-testid="tabs" data-create={String(props.create)} data-recording={String(props.recording)} />
  ),
}));
vi.mock("@/components/search-command", () => ({
  SearchCommand: ({ open, initial }: { open: boolean; initial: string }) => (
    <div data-testid="search" data-open={String(open)} data-initial={initial} />
  ),
}));
vi.mock("@/components/import-dialog", () => ({
  ImportDialog: ({ open, projectId }: { open: boolean; projectId: string | null }) => (
    <div data-testid="import" data-open={String(open)} data-folder={projectId ?? ""} />
  ),
}));
vi.mock("@/components/recording-bar", () => ({
  RecordingBar: () => <div data-testid="recording-bar" />,
}));
vi.mock("@/components/processing-dock", () => ({
  ProcessingDock: () => <div data-testid="processing-dock" />,
}));
vi.mock("@/components/folder-header-actions", () => ({
  FolderHeaderActions: ({ folderId }: { folderId: string }) => (
    <button type="button">Actions for {folderId}</button>
  ),
}));

import { AppShell } from "@/components/app-shell";
import { HEADER_SLOT_ID, HeaderSlot } from "@/components/header-slot";
import { SIDE_PANE_ID, SidePane, resetSidePane } from "@/components/side-pane";
import { openSearch, resetSearchOverlay } from "@/lib/search-overlay";

function shell(children: React.ReactNode = <p>the page</p>) {
  return render(<AppShell>{children}</AppShell>);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSearchOverlay();
  resetSidePane();
  pathname = "/home";
  recorderState = "idle";
});

describe("what it mounts on every page", () => {
  it("renders the page inside the band and the tabs", () => {
    shell();

    expect(screen.getByTestId("band")).toBeInTheDocument();
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("keeps the recorder outside itself, so it survives a navigation", () => {
    // The provider wraps the shell rather than the other way round. Inverted,
    // the recorder would be remounted by anything that remounts the shell —
    // which is the one thing recording must not be.
    shell();

    const provider = screen.getByTestId("recording-provider");
    expect(provider).toContainElement(screen.getByTestId("band"));
  });

  it("docks the recording bar and the processing dock", () => {
    // Both outlive the page that started them: the recorder keeps running when
    // you leave /record, and the pipeline keeps running when you leave the
    // meeting. Whatever reports on them has to outlive that page too.
    shell();

    expect(screen.getByTestId("recording-bar")).toBeInTheDocument();
    expect(screen.getByTestId("processing-dock")).toBeInTheDocument();
  });

  it("keeps both portal targets mounted, even with nothing in them", () => {
    // Destroying either would leave the component that fills it with nowhere to
    // render and no way to find out when there was one.
    const { container } = shell();

    expect(container.querySelector(`#${HEADER_SLOT_ID}`)).toBeInTheDocument();
    expect(container.querySelector(`#${SIDE_PANE_ID}`)).toBeInTheDocument();
  });
});

describe("search", () => {
  it("opens on Ctrl-K from anywhere", async () => {
    // Bound on the window rather than on an input, so it works while the focus
    // is in a transcript, a chat box or nothing at all.
    shell();
    expect(screen.getByTestId("search")).toHaveAttribute("data-open", "false");

    await userEvent.keyboard("{Control>}k{/Control}");

    expect(screen.getByTestId("search")).toHaveAttribute("data-open", "true");
  });

  it("opens on Cmd-K too", async () => {
    shell();

    await userEvent.keyboard("{Meta>}k{/Meta}");

    expect(screen.getByTestId("search")).toHaveAttribute("data-open", "true");
  });

  it("carries a query handed to it from three components deep", () => {
    // "Search in folder" lives on a folder's row menu. It opens this box with
    // the filter already typed, which is why the overlay is a module store and
    // not state in here.
    shell();

    act(() => openSearch('in:"Q4 planning" '));

    expect(screen.getByTestId("search")).toHaveAttribute("data-initial", 'in:"Q4 planning" ');
  });
});

describe("import", () => {
  it("opens from the band", async () => {
    shell();
    expect(screen.getByTestId("import")).toHaveAttribute("data-open", "false");

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByTestId("import")).toHaveAttribute("data-open", "true");
  });

  it("files into the folder the page is inside", async () => {
    // Read from the path because the shell does not know what page it is
    // wrapping, and the folder is what somebody standing in one expects an
    // import to land in.
    pathname = "/folder/prj_1";
    shell();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByTestId("import")).toHaveAttribute("data-folder", "prj_1");
  });

  it("files nowhere in particular anywhere else", async () => {
    shell();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(screen.getByTestId("import")).toHaveAttribute("data-folder", "");
  });
});

describe("the recorder's reach", () => {
  it("tells the band and the tabs to withhold Import and Record while one runs", () => {
    // The rule that has to survive navigation: wandering onto Home mid-meeting
    // must not put both buttons back over a live microphone. Both surfaces read
    // the same value, so they cannot disagree.
    recorderState = "recording";
    shell();

    expect(screen.getByTestId("band")).toHaveAttribute("data-create", "false");
    expect(screen.getByTestId("tabs")).toHaveAttribute("data-create", "false");
    expect(screen.getByTestId("band")).toHaveAttribute("data-recording", "true");
    expect(screen.getByTestId("tabs")).toHaveAttribute("data-recording", "true");
  });

  it("offers them again the moment the recorder is empty", () => {
    shell();

    expect(screen.getByTestId("band")).toHaveAttribute("data-create", "true");
    expect(screen.getByTestId("tabs")).toHaveAttribute("data-create", "true");
  });

  it("withholds them on the page that exists to record, before it starts", () => {
    pathname = "/record";
    shell();

    expect(screen.getByTestId("band")).toHaveAttribute("data-create", "false");
  });
});

describe("the page's own controls", () => {
  it("renders whatever a page puts in the header slot", () => {
    shell(<HeaderSlot>
      <button type="button">Export</button>
    </HeaderSlot>);

    const slot = document.getElementById(HEADER_SLOT_ID);
    expect(slot).toHaveTextContent("Export");
  });

  it("puts a folder's own actions beside the page, not in the band", () => {
    // They used to be at the right-hand end of the top bar, sharing it with
    // Import, Record and search. The band is global now and carries nothing
    // belonging to the page underneath.
    pathname = "/folder/prj_1";
    shell();

    const actions = screen.getByRole("button", { name: "Actions for prj_1" });
    expect(actions).toBeInTheDocument();
    expect(screen.getByTestId("band")).not.toContainElement(actions);
  });

  it("offers none anywhere else", () => {
    shell();

    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument();
  });
});

describe("the side pane", () => {
  it("takes no width on a page that has not filled it", () => {
    // A 26rem strip of empty card beside a meeting that is still processing is
    // a layout bug people report as a blank screen.
    const { container } = shell();

    const aside = container.querySelector("aside");
    expect(aside).toHaveClass("hidden");
  });

  it("shows once a page hands something over", () => {
    const { container } = shell(<SidePane><p>Ask this meeting</p></SidePane>);

    expect(container.querySelector("aside")).not.toHaveClass("hidden");
    expect(document.getElementById(SIDE_PANE_ID)).toHaveTextContent("Ask this meeting");
  });
});
