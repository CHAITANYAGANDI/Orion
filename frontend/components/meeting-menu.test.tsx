import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Hoisted, because `vi.mock` is: the component imports `sonner` and `@/lib/api`
 * at module scope, so both factories run before any plain `const` here has been
 * initialised.
 */
const mocks = vi.hoisted(() => ({
  assign: vi.fn(),
  unwrap: vi.fn(() => Promise.resolve({}) as Promise<unknown>),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  projects: [] as { id: string; name: string; meetingCount: number }[],
}));

vi.mock("@/lib/api", () => ({
  useGetProjectsQuery: () => ({ data: mocks.projects }),
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", nativeName: "English", rightToLeft: false },
      { code: "fr", name: "French", nativeName: "Français", rightToLeft: false },
    ],
  }),
  useAssignProjectMutation: () => [
    (a: unknown) => {
      mocks.assign(a);
      return { unwrap: mocks.unwrap };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { MeetingMenu } from "@/components/meeting-menu";

/**
 * The one menu that holds every operation on a processed meeting.
 *
 * <p>The things worth protecting are about what a click *costs*. "Copy link"
 * must never mint a public share URL — that publishes a meeting nobody asked to
 * publish, and it is one word away from the thing that does. And an operation
 * with nothing to act on must not be offered at all: a "Copy transcript" on a
 * meeting whose transcript was erased is a menu item that can only disappoint.
 *
 * <p>Several items were taken off this menu, and each is asserted absent rather
 * than simply deleted from the list above — a menu is exactly the place where a
 * removed item reappears, because adding one back is a single line and reads
 * like a fix.
 *
 * <p>The last test is about something that used to be here. "Change language…"
 * re-transcribed the audio and threw away every hand-typed correction, and it
 * sat beside a translation picker doing something else entirely. Both said
 * "language". It is asserted absent so it cannot come back by accident.
 */
function menu(over: Partial<React.ComponentProps<typeof MeetingMenu>> = {}) {
  const props = {
    meetingId: "mtg_1",
    projectId: null,
    hasTranscript: true,
    hasSummary: true,
    canTranslate: true,
    canReprocess: true,
    onCopySummary: vi.fn(),
    onCopyTranscript: vi.fn(),
    onRegenerateSummary: vi.fn(),
    onTranslate: vi.fn(),
    onRematchSpeakers: vi.fn(),
    onReprocess: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  render(<MeetingMenu {...props} />);
  return props;
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("More actions"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unwrap.mockReset().mockResolvedValue({});
  mocks.projects = [];
});

describe("MeetingMenu", () => {
  it("gathers every operation into one list", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    for (const label of [
      "Move…",
      "Copy link",
      "Copy summary",
      "Regenerate summary",
      "Copy transcript",
      "Rematch speakers",
      "Read in another language…",
      "Transcribe again",
      "Delete this meeting",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("hands each item back to the page that owns its data", async () => {
    const user = userEvent.setup();
    const props = menu();

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Copy transcript" }));
    expect(props.onCopyTranscript).toHaveBeenCalled();

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Rematch speakers" }));
    expect(props.onRematchSpeakers).toHaveBeenCalled();

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Read in another language…" }));
    expect(props.onTranslate).toHaveBeenCalled();
  });

  it("does not offer a reading language for a meeting with nothing written yet", async () => {
    const user = userEvent.setup();
    menu({ canTranslate: false });
    await open(user);

    expect(
      screen.queryByRole("menuitem", { name: "Read in another language…" }),
    ).not.toBeInTheDocument();
  });

  it("no longer offers to re-transcribe in a different language", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // Two items saying "language", one of which silently destroyed corrections.
    // Transcribing again is still here; it just cannot change the language.
    expect(screen.queryByRole("menuitem", { name: /Change language/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Transcribe again" })).toBeInTheDocument();
  });

  it("offers nothing to copy from a meeting with nothing in it", async () => {
    const user = userEvent.setup();
    menu({ hasTranscript: false, hasSummary: false });
    await open(user);

    expect(screen.queryByRole("menuitem", { name: "Copy transcript" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rematch speakers" })).not.toBeInTheDocument();
    // Deleting it is still the commonest thing to want to do with one.
    expect(screen.getByRole("menuitem", { name: "Delete this meeting" })).toBeInTheDocument();
  });

  it("keeps deleting the meeting whole, and offers no smaller grain", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // Erasing just the audio or just the transcript was two red items above
    // this one, and the three read as a graded scale of the same act. Only the
    // whole meeting can be deleted from here now.
    expect(
      screen.queryByRole("menuitem", { name: /Delete the recording/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Delete the transcript/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete this meeting" })).toBeInTheDocument();
  });

  it("does not offer an export the header is already offering", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // There is an Export button beside Share, opening this same dialog. Two
    // controls for one dialog is the kind of thing that gets one of them
    // quietly wired to something else.
    expect(
      screen.queryByRole("menuitem", { name: /Export audio/ }),
    ).not.toBeInTheDocument();
  });

  it("offers one way to copy the summary rather than two", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    expect(screen.getByRole("menuitem", { name: "Copy summary" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /formatted minutes/ }),
    ).not.toBeInTheDocument();
  });

  it("copies the in-app link, never a share link", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Copy link" }));

    // Read back off user-event's own clipboard rather than off a spy: setup()
    // installs its stub over anything defined here, and what actually landed on
    // the clipboard is the thing worth asserting anyway.
    //
    // A capability URL minted from a menu item would publish a meeting nobody
    // asked to publish. That belongs behind Share, which says what it gives away.
    const copied = await navigator.clipboard.readText();
    expect(copied).toBe(`${window.location.origin}/meetings/mtg_1`);
    expect(copied).not.toContain("/share/");
  });

  describe("Move", () => {
    it("says so when there is nowhere to move to", async () => {
      const user = userEvent.setup();
      menu();
      await open(user);
      await user.click(screen.getByRole("menuitem", { name: "Move…" }));

      // The header's picker renders as nothing at all in this case, which is
      // why the menu item has to be able to say it.
      expect(screen.getByText(/no projects yet/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Create one/ })).toBeInTheDocument();
    });

    it("files into the chosen project", async () => {
      const user = userEvent.setup();
      mocks.projects = [{ id: "prj_1", name: "Platform", meetingCount: 4 }];
      menu();
      await open(user);
      await user.click(screen.getByRole("menuitem", { name: "Move…" }));
      await user.click(screen.getByRole("button", { name: /Platform/ }));

      expect(mocks.assign).toHaveBeenCalledWith({ meetingId: "mtg_1", projectId: "prj_1" });
    });

    it("can take a meeting back out", async () => {
      const user = userEvent.setup();
      mocks.projects = [{ id: "prj_1", name: "Platform", meetingCount: 4 }];
      menu({ projectId: "prj_1" });
      await open(user);
      await user.click(screen.getByRole("menuitem", { name: "Move…" }));
      await user.click(screen.getByRole("button", { name: /Unfiled/ }));

      expect(mocks.assign).toHaveBeenCalledWith({ meetingId: "mtg_1", projectId: null });
    });
  });
});
