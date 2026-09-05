import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  MeetingResponse,
  SummaryResponse,
  SummarySection,
  TranscriptSegment,
} from "@/lib/types";

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
let summary: SummaryResponse | undefined;
/** How the summary request is going. See the mock. */
let summaryQuery: "ok" | "loading" | "error" | "absent" | "stale-over-error";
/** Templates the picker offers. Empty by default; one test needs two. */
let templates: { slug: string; name: string }[];
/** How the transcript request is going. */
let transcriptQuery: "ok" | "error" | "absent";
/** The flat body a document import has instead of utterances. */
let transcriptText: string | undefined;

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "mtg_1" }),
  useRouter: () => ({ push }),
  usePathname: () => "/meetings/mtg_1",
}));

vi.mock("@/lib/api", () => ({
  // `getSummary` answers absence with a 404 rather than an empty body, so for
  // that one endpoint a settled 404 is the proof of absence that a settled 200
  // is elsewhere. See `meetingPanels`.
  isNotFoundError: () => summaryQuery === "absent",
  useGetMeetingQuery: () => ok(meeting),
  // The one query with more than one interesting state, so it goes through a
  // switch rather than a fixture. Every branch below is a screen the brief can
  // legitimately be, and three of them used to be the same screen.
  useGetSummaryQuery: () => {
    if (summaryQuery === "loading") {
      return { ...ok(undefined), isLoading: true, isFetching: true, isSuccess: false };
    }
    if (summaryQuery === "error" || summaryQuery === "absent") {
      return {
        ...ok(undefined),
        isError: true,
        isSuccess: false,
        error: { status: 500, data: { message: "boom" } },
      };
    }
    if (summaryQuery === "stale-over-error") {
      return { ...ok(summary), isError: true, error: { status: 500 } };
    }
    return ok(summary);
  },
  useGetTranscriptQuery: () => {
    if (transcriptQuery === "error") {
      return {
        ...ok(undefined),
        isError: true,
        isSuccess: false,
        error: { status: 500, data: { message: "boom" } },
      };
    }
    if (transcriptQuery === "absent") return { ...ok(undefined), isSuccess: false };
    return ok({ segments, speakers: [], transcript: transcriptText });
  },
  // A bare array here, not a page: this endpoint answers one meeting.
  useGetMeetingActionItemsQuery: () => ok([]),
  useGetChatQuery: () => ok({ messages: [] }),
  useGetChatModesQuery: () => ok([]),
  useGetTranslationsQuery: () => ok([]),
  useGetLanguagesQuery: () => ok([]),
  useGetSummaryTemplatesQuery: () => ok(templates),
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
vi.mock("@/components/transcript-editor", () => ({
  TranscriptEditor: () => <div data-testid="transcript-editor" />,
}));
vi.mock("@/components/selection-menu", () => ({
  SelectionMenu: () => <div data-testid="selection-menu" />,
  isInsideSelectionMenu: () => false,
}));
vi.mock("@/components/turn-actions", () => ({
  TurnActions: () => <div data-testid="turn-actions" />,
  TurnReactions: () => null,
}));
vi.mock("@/components/moments-panel", () => ({ MomentsPanel: () => null }));
vi.mock("@/components/outline-nav", () => ({ OutlineNav: () => null }));
vi.mock("@/components/translated-transcript", () => ({ TranslatedTranscript: () => null }));
vi.mock("@/components/new-action-item-dialog", () => ({ NewActionItemDialog: () => null }));
vi.mock("@/components/moment-composer", () => ({
  ActionItemDialog: () => <div data-testid="action-item-dialog" />,
  NoteDialog: () => <div data-testid="note-dialog" />,
}));
vi.mock("@/components/reassign-speaker-dialog", () => ({
  ReassignSpeakerDialog: () => <div data-testid="reassign-dialog" />,
}));
vi.mock("@/components/speaker-editor", () => ({
  SpeakerEditor: () => <div data-testid="speaker-editor" />,
}));

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
    // `start`/`end`, which is what the type says. Naming them `startTime` here
    // typechecked through the `as` cast and produced a transcript with every
    // utterance at 0:00 -- silently, and only the timecode assertions noticed.
    start: 0,
    end: 6,
    ...over,
  };
}

function aSection(over: Partial<SummarySection> = {}): SummarySection {
  return { key: "s1", title: "Budget", kind: "prose", text: "", bullets: [], groups: [], ...over };
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
  summaryQuery = "ok";
  templates = [];
  transcriptQuery = "ok";
  transcriptText = undefined;
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

/**
 * The brief — every shape it can take, and every state it can be in.
 *
 * <h2>Why this is the page's test and not the panel's</h2>
 *
 * <p>`SummaryPanel` is a local function inside this file's subject rather than
 * an exported component, so the page is the only place it can be exercised at
 * all. That is not a compromise: what makes the brief hard is that a summary
 * can be present, absent, being written, failed, stale, translated, or
 * pre-dating the template system — and several of those used to render as the
 * same screen. "No summary available." over a summary that existed is the
 * screenshot this whole state machine was built for.
 *
 * <p>Phase 7 replaced the presentation of all of it. Each case below is one of
 * the capabilities inventoried before a line changed.
 */
describe("the brief", () => {
  it("reads a summary that pre-dates templates from its flat fields", () => {
    // No sections, so the lead, the key points and the long form are the
    // document. Still rendered — a redesign that handles only the new shape
    // silently blanks every meeting summarised before templates existed.
    summary = aSummary({
      shortSummary: "We shipped the redesign.",
      keyPoints: ["Ship on the ninth", "Freeze on the seventh"],
      detailedSummary: "A longer account of the same.",
    });
    render(<MeetingDetailPage />);

    expect(screen.getByText("We shipped the redesign.")).toBeInTheDocument();
    expect(screen.getByText("Ship on the ninth")).toBeInTheDocument();
    expect(screen.getByText("A longer account of the same.")).toBeInTheDocument();
  });

  it("prefers structured sections when the summary has them", () => {
    summary = aSummary({
      shortSummary: "ignored when there are sections",
      sections: [aSection({ title: "Budget", kind: "prose", text: "No budget was set." })],
    });
    render(<MeetingDetailPage />);

    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByText("No budget was set.")).toBeInTheDocument();
  });

  it("keeps an empty section's heading, because the absence is a finding", () => {
    // "Budget" with nothing under it tells the reader budget never came up.
    // Inferring the shape from the data would silently hide that.
    summary = aSummary({ sections: [aSection({ title: "Risks" })] });
    render(<MeetingDetailPage />);

    expect(screen.getByRole("heading", { name: "Risks" })).toBeInTheDocument();
    expect(screen.getByText("Not discussed.")).toBeInTheDocument();
  });

  it("draws a bullets section as bullets", () => {
    summary = aSummary({
      sections: [aSection({ kind: "bullets", bullets: ["First thing", "Second thing"] })],
    });
    render(<MeetingDetailPage />);

    expect(screen.getByText("First thing")).toBeInTheDocument();
    expect(screen.getByText("Second thing")).toBeInTheDocument();
  });

  it("makes an anchored outline heading play from its moment", async () => {
    summary = aSummary({
      sections: [
        aSection({
          kind: "outline",
          key: "outline",
          groups: [{ heading: "Pricing", startSeconds: 754, bullets: ["We held the price."] }],
        }),
      ],
    });
    render(<MeetingDetailPage />);

    const heading = screen.getByRole("button", { name: /Pricing/ });
    expect(heading).toHaveAttribute("title", "Play from 12:34");

    await userEvent.click(heading);

    // Following a citation out of the brief takes you to the words it was
    // read from, with the player already there. Seeking under a summary the
    // reader cannot see the timeline of would be a control acting off screen.
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("leaves an unanchored heading as plain text, not a link to a guess", () => {
    // A link that lands on the wrong minute is indistinguishable from a
    // transcript that disagrees with its own summary, and the reader has no way
    // to tell which of the two is broken.
    summary = aSummary({
      sections: [
        aSection({
          kind: "outline",
          key: "outline",
          groups: [{ heading: "Pricing", startSeconds: null, bullets: ["We held the price."] }],
        }),
      ],
    });
    render(<MeetingDetailPage />);

    expect(screen.queryByRole("button", { name: /Pricing/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pricing" })).toBeInTheDocument();
  });

  it("lists the topics from the outline's own headings", () => {
    // Not a second list generated separately, which could disagree with the
    // outline and leave two answers to "what was discussed".
    summary = aSummary({
      sections: [
        aSection({
          kind: "outline",
          key: "outline",
          groups: [
            { heading: "Pricing", startSeconds: 10, bullets: [] },
            { heading: "Hiring", startSeconds: 90, bullets: [] },
          ],
        }),
      ],
    });
    render(<MeetingDetailPage />);

    expect(screen.getByText("Topics discussed")).toBeInTheDocument();
    expect(screen.getAllByText("Pricing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Hiring").length).toBeGreaterThan(0);
  });

  it("does not read topics out of a section that merely looks like an outline", () => {
    // Keyed on `outline`, not on kind: the Interview template pairs each
    // question with its answer in the outline SHAPE, and those headings are
    // questions rather than topics the meeting covered.
    summary = aSummary({
      sections: [
        aSection({
          kind: "outline",
          key: "questions",
          groups: [{ heading: "Why did you leave?", startSeconds: 10, bullets: [] }],
        }),
      ],
    });
    render(<MeetingDetailPage />);

    expect(screen.queryByText("Topics discussed")).not.toBeInTheDocument();
  });

  it("shows verified quotations, playable at the moment they were said", () => {
    summary = aSummary({
      sections: [aSection({ text: "x" })],
      quotes: [{ text: "We ship on the ninth.", speaker: "Priya", start: 754 }],
    });
    render(<MeetingDetailPage />);

    expect(screen.getByText("Key quotations")).toBeInTheDocument();
    expect(screen.getByText(/We ship on the ninth/)).toBeInTheDocument();
    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(screen.getByText("12:34")).toBeInTheDocument();
  });

  it("names an unattributed quotation rather than leaving a gap", () => {
    summary = aSummary({
      sections: [aSection({ text: "x" })],
      quotes: [{ text: "We ship on the ninth.", speaker: "", start: 0 }],
    });
    render(<MeetingDetailPage />);

    expect(screen.getByText("Unknown speaker")).toBeInTheDocument();
  });

  it("shows no quotations section when nothing was verified", () => {
    // A normal outcome rather than a failure, and an empty decorative box
    // headed "Key quotations" would report it as one.
    summary = aSummary({ sections: [aSection({ text: "x" })], quotes: [] });
    render(<MeetingDetailPage />);

    expect(screen.queryByText("Key quotations")).not.toBeInTheDocument();
  });
});

/**
 * The brief when it is not simply there.
 *
 * <p>Six states, and three of them used to be one. `panelState` is what tells
 * them apart and it has its own unit tests; what is asserted here is that the
 * page draws the right screen for each — which is the half that was wrong in
 * production.
 */
describe("the brief's states", () => {
  it("shows a skeleton before the first answer, not an absence", () => {
    summaryQuery = "loading";
    const { container } = render(<MeetingDetailPage />);

    expect(screen.queryByText("No summary available.")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("says the request failed rather than that there is no summary", () => {
    // THE screenshot: "No summary available." over a summary sitting in the
    // database, produced by a panel describing its own network.
    summaryQuery = "error";
    render(<MeetingDetailPage />);

    expect(screen.getByText("Couldn't load the summary")).toBeInTheDocument();
    expect(screen.queryByText("No summary available.")).not.toBeInTheDocument();
  });

  it("offers a retry on the failure, wired to refetch", async () => {
    summaryQuery = "error";
    render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(refetch).toHaveBeenCalled();
  });

  it("keeps a summary on screen when a refetch over it fails", () => {
    // Content beats any news about the request that fetched it. Blanking a
    // brief somebody is reading because a refresh they did not ask for failed
    // is strictly worse than showing it.
    summaryQuery = "stale-over-error";
    summary = aSummary({ shortSummary: "Still readable." });
    render(<MeetingDetailPage />);

    expect(screen.getByText("Still readable.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the summary")).not.toBeInTheDocument();
  });

  it("says a summary is being written rather than missing, while the meeting runs", () => {
    meeting = aMeeting({ status: "SUMMARIZING" });
    summary = undefined;
    render(<MeetingDetailPage />);

    // Twice: the stage strip above says it too, and they must agree.
    expect(screen.getAllByText(/Generating summary/).length).toBeGreaterThan(0);
    expect(screen.queryByText("No summary available.")).not.toBeInTheDocument();
  });

  it("says it is waiting for the transcript before there is one to read", () => {
    meeting = aMeeting({ status: "TRANSCRIBING" });
    summary = undefined;
    segments = [];
    render(<MeetingDetailPage />);

    expect(screen.getByText(/waiting for the transcript/)).toBeInTheDocument();
  });

  it("says there is none only once the server has proved it", () => {
    // The one state in which "No summary available." is a true sentence, and
    // it is reached from a settled 404 rather than from `!data` -- which is
    // also what a 500 looks like.
    summary = undefined;
    summaryQuery = "absent";
    render(<MeetingDetailPage />);

    expect(screen.getByText("No summary available.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the summary")).not.toBeInTheDocument();
  });

  it("draws a blank summary body as the document it is, not as an absence", () => {
    // A 200 with every field empty is not something the backend produces today
    // -- absence is a 404 -- but a row written from a failed model call could
    // be. Content beats everything, so the brief renders empty rather than
    // claiming there is none: saying "No summary available." over a row that
    // exists is the same class of lie as saying it over a full one.
    summary = aSummary({ shortSummary: "", detailedSummary: "", keyPoints: [], sections: [] });
    render(<MeetingDetailPage />);

    expect(screen.queryByText("No summary available.")).not.toBeInTheDocument();
  });
});

/**
 * Rewriting the brief.
 *
 * <p>Two entry points, and they must not disagree: the template picker on the
 * mode row, and the "the transcript changed" notice inside the document. Both
 * spend a model call, so both answer to the allowance.
 */
describe("rewriting the brief", () => {
  it("offers the template picker only once there is a brief to rewrite", () => {
    templates = [
      { slug: "general", name: "General" },
      { slug: "standup", name: "Standup" },
    ];
    const { unmount } = render(<MeetingDetailPage />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    unmount();

    // A picker over a brief that does not exist yet is a control that cannot
    // do anything.
    summary = undefined;
    meeting = aMeeting({ status: "SUMMARIZING" });
    render(<MeetingDetailPage />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does not offer it over a transcript, which it cannot change", async () => {
    templates = [{ slug: "general", name: "General" }];
    render(<MeetingDetailPage />);

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("says the transcript changed under a stale summary, and offers the rewrite", () => {
    // Not rewritten automatically — that would spend a model call on every typo
    // fix, and on each of the next nineteen — so the choice is offered rather
    // than made.
    summary = aSummary({ stale: true, sections: [aSection({ text: "x" })] });
    render(<MeetingDetailPage />);

    expect(screen.getByText(/transcript changed after this summary/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rewrite it/ })).toBeInTheDocument();
  });

  it("says nothing about staleness when a summary is fresh", () => {
    summary = aSummary({ stale: false, sections: [aSection({ text: "x" })] });
    render(<MeetingDetailPage />);

    expect(screen.queryByText(/transcript changed/)).not.toBeInTheDocument();
  });
});

/**
 * The transcript — the highest-risk surface in the redesign.
 *
 * <h2>What is asserted here, and what is not</h2>
 *
 * <p>`SelectionMenu`, `TurnActions`, `SpeakerEditor`, `ReassignSpeakerDialog`,
 * `TranscriptEditor`, `TranslatedTranscript` and `MomentsPanel` each have their
 * own test file, and they are mocked out above. What none of those can catch is
 * the page failing to *mount* one of them, mounting it in the wrong reading
 * mode, or severing the wires between them: the `data-seg` and `data-speaker`
 * attributes a selection is recovered from, the per-word seek, the
 * active-utterance tint that follows the audio.
 *
 * <p>Those wires are the whole reason this phase was risky. A transcript that
 * renders beautifully and no longer plays from the word you clicked is a
 * regression no component test would see, because every component involved is
 * still perfect on its own.
 */
describe("the transcript", () => {
  /** Get to the transcript, which is not the mode the page opens in. */
  async function readTranscript() {
    const view = render(<MeetingDetailPage />);
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    return view;
  }

  it("draws a turn with its speaker, its timecode and its words", async () => {
    segments = [aSegment({ speaker: "Priya", text: "We agreed to ship on the ninth.", start: 754, end: 760 })];
    await readTranscript();

    // Twice on purpose: the talk-time roll-call above names them too, and the
    // two must agree. `getAllBy` rather than a scoped query, because "the name
    // appears exactly where it should and nowhere else" is the assertion.
    expect(screen.getAllByText("Priya")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Play from 12:34" })).toBeInTheDocument();
    expect(screen.getByText("agreed")).toBeInTheDocument();
  });

  it("gives every word its own seek target, not just the playing one", async () => {
    // Any word in the transcript can be clicked to play from it. The memo that
    // keeps inactive utterances from re-rendering per frame is what makes that
    // affordable, and it is easy to lose while restyling the span it hangs on.
    segments = [aSegment({ text: "We agreed to ship." })];
    await readTranscript();

    const word = screen.getByText("agreed");
    expect(word).toHaveAttribute("data-word");
    expect(word).toHaveAttribute("data-start");
    expect(word).toHaveAttribute("role", "button");
  });

  it("keeps the attributes a selection is recovered from", async () => {
    // `readSelection` walks up from the selection with `closest("[data-seg]")`
    // to find which utterance and which speaker a passage belongs to. Drop
    // either attribute and highlighting, quoting, noting and "ask about this"
    // all stop working at once — silently, since the menu still opens.
    segments = [aSegment({ id: "seg_9", speaker: "Priya" })];
    const { container } = await readTranscript();

    const utterance = container.querySelector('[data-seg="seg_9"]');
    expect(utterance).not.toBeNull();
    expect(utterance).toHaveAttribute("data-speaker", "Priya");
  });

  it("groups consecutive utterances by one speaker into a single turn", async () => {
    // Diarization emits an utterance per pause, so a minute of one person
    // arrives as several segments. One row each reads as a stack of fragments
    // with the same name repeated down the page.
    segments = [
      aSegment({ id: "a", speaker: "Priya", text: "First part.", start: 0, end: 3 }),
      aSegment({ id: "b", speaker: "Priya", text: "Second part.", start: 3, end: 6 }),
    ];
    await readTranscript();

    // One turn, so one timecode: the heading of a turn is where its
    // playback starts, and two here would mean the grouping did not happen.
    expect(screen.getAllByRole("button", { name: /^Play from/ })).toHaveLength(1);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("still seeks each utterance separately inside that turn", async () => {
    segments = [
      aSegment({ id: "a", speaker: "Priya", text: "First.", start: 0, end: 3 }),
      aSegment({ id: "b", speaker: "Priya", text: "Second.", start: 30, end: 33 }),
    ];
    const { container } = await readTranscript();

    // Two utterances under one name; nothing was merged away.
    expect(container.querySelectorAll("[data-seg]")).toHaveLength(2);
  });

  it("mounts the selection menu, which every marking gesture goes through", async () => {
    await readTranscript();

    expect(screen.getByTestId("selection-menu")).toBeInTheDocument();
  });

  it("mounts the note and action-item composers a selection opens", async () => {
    await readTranscript();

    expect(screen.getByTestId("note-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("action-item-dialog")).toBeInTheDocument();
  });

  it("mounts the speaker correction dialog", async () => {
    await readTranscript();

    expect(screen.getByTestId("reassign-dialog")).toBeInTheDocument();
  });

  it("offers a per-turn toolbar for reactions, notes, copying and links", async () => {
    await readTranscript();

    expect(screen.getByTestId("turn-actions")).toBeInTheDocument();
  });

  it("offers Find in transcript, and says how many matched", async () => {
    segments = [
      aSegment({ id: "a", text: "We agreed to ship." }),
      aSegment({ id: "b", speaker: "Dev", text: "Nothing about that here." }),
    ];
    await readTranscript();

    await userEvent.type(screen.getByLabelText("Find in transcript"), "agreed");

    expect(screen.getByText(/1 match in 1 turn/)).toBeInTheDocument();
  });

  it("says a search matched nothing rather than emptying the page", async () => {
    // Without this the panel just empties, which reads as a transcript that
    // failed to load.
    await readTranscript();

    await userEvent.type(screen.getByLabelText("Find in transcript"), "zzzz");

    expect(screen.getByText(/Nothing in this transcript matches/)).toBeInTheDocument();
  });

  it("shows talk time and the way into speaker editing", async () => {
    segments = [
      aSegment({ id: "a", speaker: "Priya", start: 0, end: 60 }),
      aSegment({ id: "b", speaker: "Dev", start: 60, end: 90 }),
    ];
    await readTranscript();

    expect(screen.getByText("Talk time")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit speakers" }));
    expect(screen.getByTestId("speaker-editor")).toBeInTheDocument();
  });

  it("offers a per-line correction without leaving the reading mode", async () => {
    // The line editor replaces one line so the rest of the turn stays readable
    // and still seekable while a correction is being typed. Distinct from the
    // whole-transcript editor, which is a mode.
    segments = [aSegment({ id: "seg_9", text: "We agreed." })];
    await readTranscript();

    await userEvent.click(screen.getByRole("button", { name: "Correct this line" }));

    // Not `getByRole("textbox")`: the find box is one too, and the whole point
    // of the line editor is that it opens *inside* a transcript that is still
    // searchable and still seekable around it.
    const editors = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA");
    expect(editors).toHaveLength(1);
    expect(editors[0]).toHaveValue("We agreed.");
  });

  it("hands the whole transcript to the editor when that mode is chosen", async () => {
    await readTranscript();

    await userEvent.click(screen.getByRole("button", { name: /Edit Transcript/ }));

    expect(screen.getByTestId("transcript-editor")).toBeInTheDocument();
  });
});

/**
 * The transcript when it is not simply there.
 *
 * <p>The same rule as the brief, and the same production screenshot behind it:
 * "Transcript unavailable." printed over a transcript that was in the database
 * the whole time.
 */
describe("the transcript's states", () => {
  async function readTranscript() {
    const view = render(<MeetingDetailPage />);
    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    return view;
  }

  it("says the request failed rather than that there is no transcript", async () => {
    transcriptQuery = "error";
    await readTranscript();

    expect(screen.getByText("Couldn't load the transcript")).toBeInTheDocument();
    expect(screen.queryByText("Transcript unavailable.")).not.toBeInTheDocument();
  });

  it("offers a retry on the failure, wired to refetch", async () => {
    transcriptQuery = "error";
    await readTranscript();

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(refetch).toHaveBeenCalled();
  });

  it("says a transcript is being prepared rather than missing, while the meeting runs", async () => {
    // An empty transcript looks like a recording that captured nothing, which
    // is the one conclusion that must not be drawn from a meeting still being
    // transcribed.
    meeting = aMeeting({ status: "TRANSCRIBING" });
    segments = [];
    transcriptQuery = "absent";
    await readTranscript();

    expect(screen.queryByText("Transcript unavailable.")).not.toBeInTheDocument();
  });

  it("renders a document's body, which has no utterances at all", async () => {
    // A PDF import and a transcript from before segments existed are both real
    // transcripts, and counting only segments would call them missing.
    meeting = aMeeting({ sourceType: "DOCUMENT", audioUrl: null });
    segments = [];
    transcriptText = "The whole document, as one body of text.";
    await readTranscript();

    expect(screen.getByText(/The whole document/)).toBeInTheDocument();
    expect(screen.queryByText("Transcript unavailable.")).not.toBeInTheDocument();
  });
});
