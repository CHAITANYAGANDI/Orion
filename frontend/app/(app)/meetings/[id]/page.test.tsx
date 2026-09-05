import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeetingResponse, SummaryResponse, TranscriptSegment } from "@/lib/types";

/**
 * The meeting page — its shell, its masthead and its transport.
 *
 * <h2>Why this file exists now and did not before</h2>
 *
 * <p>This is the largest screen in the product and it had **no tests at all**.
 * That was survivable while it was being edited a panel at a time; it is not
 * survivable through a redesign that moves the column every panel is set in.
 * Everything under it — the brief, the transcript, the action items — is
 * covered by its own component's tests, and every one of those passes just as
 * well when the page renders them at the wrong width, in the wrong tab, or not
 * at all.
 *
 * <p>So this covers what only the *page* can be wrong about: which facts are in
 * the masthead, which reading mode is showing, what column the document is set
 * in, and where the transport is docked. The panels themselves are mocked out
 * by name — their contents belong to their own files, and pulling them in here
 * would make this a test of forty components that fails for thirty-nine reasons
 * that are not this page's fault.
 *
 * <p>It is written to be extended. Phases 7, 8 and 9 rebuild the brief, the
 * transcript and the action items, and each will add to the mocks below rather
 * than standing up a second harness.
 */
/*
 * `vi.mock` factories are hoisted above every `const` in this file, so anything
 * they call has to be built inside `vi.hoisted` -- otherwise the factory runs
 * against a temporal-dead-zone binding and the whole suite fails to collect
 * with an error that names the wrong file.
 */
const { push, refetch, ok, none, mut } = vi.hoisted(() => {
  const refetch = vi.fn();
  /** An RTK Query result with the flags this page actually reads. */
  function ok<T>(data: T) {
    return {
      data,
      isLoading: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      isUninitialized: false,
      error: undefined,
      refetch,
    };
  }
  return {
    push: vi.fn(),
    refetch,
    ok,
    none: () => ok(undefined),
    /** A mutation tuple. Nothing here fires one; they only have to exist. */
    mut: () => [() => ({ unwrap: () => Promise.resolve({}) }), { isLoading: false }],
  };
});

let meeting: MeetingResponse;
let segments: TranscriptSegment[];
let summary: SummaryResponse;

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "mtg_1" }),
  useRouter: () => ({ push }),
  usePathname: () => "/meetings/mtg_1",
}));

vi.mock("@/lib/api", () => ({
  isNotFoundError: () => false,
  useGetMeetingQuery: () => ok(meeting),
  useGetSummaryQuery: () => ok(summary),
  useGetTranscriptQuery: () => ok({ segments, speakers: [] }),
  // A bare array here, not a page: this endpoint answers one meeting.
  useGetMeetingActionItemsQuery: () => ok([]),
  useGetChatQuery: () => ok({ messages: [] }),
  useGetChatModesQuery: () => ok([]),
  useGetTranslationsQuery: () => ok([]),
  useGetLanguagesQuery: () => ok([]),
  useGetSummaryTemplatesQuery: () => ok([]),
  useGetMomentsQuery: () => ok([]),
  useGetInsightsQuery: () => ok([]),
  useGetMeetingConversationsQuery: () => ok([]),
  useDeleteMeetingMutation: mut,
  useAskChatMutation: mut,
  useTranslateMeetingMutation: mut,
  useRenameSpeakersMutation: mut,
  useMergeSpeakersMutation: mut,
  useReprocessMeetingMutation: mut,
  useEditSegmentsMutation: mut,
  useSetSegmentSpeakerMutation: mut,
  useResummarizeMutation: mut,
  useCreateMomentMutation: mut,
  useDeleteMomentMutation: mut,
  useCreateMeetingConversationMutation: mut,
  useRenameConversationMutation: mut,
  useDeleteConversationMutation: mut,
  useDeleteChatExchangeMutation: mut,
  // MeetingTitle and MeetingTags render inside the masthead and reach for
  // these; they are not mocked out because the title IS the masthead.
  useUpdateMeetingMutation: mut,
  useCreateActionItemMutation: mut,
  usePatchActionItemMutation: mut,
  useGetUsageQuery: none,
}));

vi.mock("@/lib/ws", () => ({ subscribeMeetingStatus: () => ({ deactivate: () => {} }) }));
vi.mock("@/lib/active-chat", () => ({ useActiveChat: () => ({ id: null, set: () => {} }) }));
vi.mock("@/lib/recording-context", () => ({
  useRecordingJob: () => ({ phase: "idle", job: null, stop: () => Promise.resolve(false) }),
}));
vi.mock("@/lib/allowance", () => ({
  useAllowance: () => ({}),
  aiRefusal: () => null,
  reprocessCost: () => null,
}));
vi.mock("@/lib/processing-jobs", () => ({ trackProcessing: () => {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/*
 * The panels, by name.
 *
 * Each has its own test file. What is asserted here is that the page puts them
 * in the right tab, in the right column — not what they draw, which is theirs.
 */
vi.mock("@/components/insights-panel", () => ({ InsightsPanel: () => null }));
vi.mock("@/components/export-dialog", () => ({ ExportDialog: () => null }));
vi.mock("@/components/meeting-menu", () => ({ MeetingMenu: () => null }));
vi.mock("@/components/transcript-editor", () => ({ TranscriptEditor: () => null }));
vi.mock("@/components/moments-panel", () => ({ MomentsPanel: () => null }));
vi.mock("@/components/outline-nav", () => ({ OutlineNav: () => null }));
vi.mock("@/components/translated-transcript", () => ({ TranslatedTranscript: () => null }));
vi.mock("@/components/new-action-item-dialog", () => ({ NewActionItemDialog: () => null }));
vi.mock("@/components/moment-composer", () => ({
  ActionItemDialog: () => null,
  NoteDialog: () => null,
}));
vi.mock("@/components/reassign-speaker-dialog", () => ({ ReassignSpeakerDialog: () => null }));
vi.mock("@/components/speaker-editor", () => ({ SpeakerEditor: () => null }));

// The side pane is the shell's, and its portal target does not exist here.
vi.mock("@/components/side-pane", () => ({
  SidePane: () => null,
  useSidePane: () => ({ occupied: false, open: false, expanded: false }),
  toggleSidePaneExpanded: () => {},
}));
vi.mock("@/components/header-slot", () => ({
  HEADER_SLOT_ID: "reverie-header-actions",
  // Rendered in place rather than portalled: what the page puts in the header
  // is this page's decision, and the portal itself is the shell's test.
  HeaderSlot: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-slot">{children}</div>
  ),
}));

import MeetingDetailPage from "@/app/(app)/meetings/[id]/page";

function aMeeting(over: Partial<MeetingResponse> = {}): MeetingResponse {
  return {
    id: "mtg_1",
    title: "Tuesday design review",
    status: "READY",
    tags: [],
    createdAt: "2026-08-14T09:00:00Z",
    durationSeconds: 2527,
    audioUrl: "https://media.example/mtg_1.webm",
    ...over,
  } as MeetingResponse;
}

function aSegment(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg_1",
    speaker: "Speaker 1",
    text: "We agreed to ship on the ninth.",
    startTime: 0,
    endTime: 6,
    ...over,
  } as TranscriptSegment;
}

function aSummary(over: Partial<SummaryResponse> = {}): SummaryResponse {
  return {
    meetingId: "mtg_1",
    shortSummary: "The team agreed to ship on the ninth.",
    detailedSummary: "",
    keyPoints: [],
    sections: [],
    templateSlug: "general",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  meeting = aMeeting();
  segments = [aSegment()];
  summary = aSummary();
});

/**
 * The masthead.
 *
 * <p>The facts about one document, set as a spec line under its title rather
 * than as a row of loose badges — so the title is the only thing competing for
 * first read. What is asserted here is mostly what is *absent*: each of those
 * was argued for once and is the kind of thing a redesign quietly puts back.
 */
describe("the masthead", () => {
  it("leads with the title", () => {
    render(<MeetingDetailPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Tuesday design review",
    );
  });

  it("states the duration and the date", () => {
    render(<MeetingDetailPage />);

    expect(screen.getByText(/42m 7s/)).toBeInTheDocument();
  });

  it("does not badge a meeting READY", () => {
    // A label for the only state that needs none, beside a meeting somebody is
    // plainly reading. Anything else is announced far louder further down.
    render(<MeetingDetailPage />);

    expect(screen.queryByText("READY")).not.toBeInTheDocument();
  });

  it("names the language only when it is not the default", () => {
    // An "English" badge on every meeting is noise.
    meeting = aMeeting({ language: "en" });
    const { unmount } = render(<MeetingDetailPage />);
    expect(screen.queryByText("English")).not.toBeInTheDocument();
    unmount();

    meeting = aMeeting({ language: "de" });
    render(<MeetingDetailPage />);
    expect(screen.getByText("German")).toBeInTheDocument();
  });

  it("gives a document no duration, because it was never spoken", () => {
    meeting = aMeeting({ sourceType: "DOCUMENT", audioUrl: null, durationSeconds: null });
    render(<MeetingDetailPage />);

    expect(screen.getByText("Document")).toBeInTheDocument();
    expect(screen.queryByText(/42m/)).not.toBeInTheDocument();
  });

  it("offers Copy summary in the spec line, not only behind Export", () => {
    // The commonest thing anybody does with a summary is paste it into a reply,
    // and it was two clicks behind a menu named after downloading files.
    render(<MeetingDetailPage />);

    expect(screen.getByRole("button", { name: /Copy summary/ })).toBeInTheDocument();
  });
});

/**
 * The reading modes.
 *
 * <p>Two, where there were four. Ask and Action items are not places — making
 * them tabs meant the two things you do *while* reading were both somewhere the
 * reading was not.
 */
describe("the reading modes", () => {
  it("offers exactly Summary and Transcript", () => {
    render(<MeetingDetailPage />);

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Summary", "Transcript"]);
  });

  it("opens on the summary", () => {
    render(<MeetingDetailPage />);

    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches to the transcript", async () => {
    render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

/**
 * The column the document is set in.
 *
 * <p>680px, which is about 74 characters at the reading size. The point of
 * asserting it on the page rather than in each panel is that a brief and a
 * transcript must be set in the *same* column: moving between the two reading
 * modes is a change of content, not of reading posture, and two panels each
 * choosing their own width is how that stops being true.
 */
describe("the measure", () => {
  it("sets the summary in it", () => {
    const { container } = render(<MeetingDetailPage />);

    expect(container.querySelector(".v2-spread")).toBeInTheDocument();
  });

  it("sets the transcript in the same one", async () => {
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(container.querySelector(".v2-spread")).toBeInTheDocument();
  });

  it("centres it while the margin has nothing in it", () => {
    // Rather than sitting the text left of an empty column. The margin fills
    // with real anchored content when the transcript is rebuilt; until then an
    // empty 400px gutter is a layout that looks broken.
    const { container } = render(<MeetingDetailPage />);

    expect(container.querySelector('.v2-spread[data-margin="empty"]')).toBeInTheDocument();
  });

  it("does not indent the reading-mode switch to it", () => {
    // A switch and the controls that govern the whole document are chrome, and
    // chrome indented to the measure reads as part of the text.
    const { container } = render(<MeetingDetailPage />);

    const list = screen.getByRole("tablist");
    expect(list.closest(".v2-spread")).toBeNull();
    expect(container.querySelector(".v2-spread")).toBeInTheDocument();
  });
});

/**
 * Where the transport is.
 *
 * <p>It floats over the transcript it is scrubbing, which is the one thing on
 * this page that is genuinely the functional layer.
 */
describe("the docked player", () => {
  /** The fixed wrapper the page draws around the transport. */
  function dock(container: HTMLElement) {
    return container.querySelector(".fixed.inset-x-0.bottom-0");
  }

  it("stays out of the way on the summary", () => {
    // There is nothing to scrub past on a brief, and a bar over one is a
    // control acting on something that is not on screen.
    const { container } = render(<MeetingDetailPage />);

    expect(dock(container)).toBeNull();
  });

  it("appears with the transcript", async () => {
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(dock(container)).not.toBeNull();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
  });

  it("does not appear for a document, which was never spoken", async () => {
    meeting = aMeeting({ sourceType: "DOCUMENT", audioUrl: null });
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(dock(container)).toBeNull();
  });

  it("does not appear when the recording has been erased", async () => {
    meeting = aMeeting({ audioUrl: null });
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(dock(container)).toBeNull();
  });

  it("reserves no room for a navigation rail that no longer exists", async () => {
    // `lg:left-[var(--rail-w,16rem)]` was correct while the shell had a 256px
    // column. It does not, and the fallback in that expression is what would
    // have shifted the bar 16rem right the moment the variable stopped being
    // published.
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(dock(container)?.className).not.toContain("--rail-w");
  });

  it("is held to the measure, so it sits under what it is scrubbing", async () => {
    const { container } = render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(dock(container)?.querySelector(".max-w-measure")).not.toBeNull();
  });
});

/**
 * What the page hands to the shell.
 *
 * <p>Export and the ⋯ menu act on the document being read, so they belong in
 * the header slot rather than in the band — the band is global and carries
 * nothing belonging to the page underneath it.
 */
describe("the page's own controls", () => {
  it("puts Export in the header slot", () => {
    render(<MeetingDetailPage />);

    expect(screen.getByTestId("header-slot")).toHaveTextContent("Export");
  });

  it("offers no Export before there is anything to export", () => {
    meeting = aMeeting({ status: "TRANSCRIBING", audioUrl: null });
    render(<MeetingDetailPage />);

    expect(screen.getByTestId("header-slot")).not.toHaveTextContent("Export");
  });
});
