import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Hoisted, because `vi.mock` is: the component imports `sonner` and `@/lib/api`
 * at module scope, so both factories run before any plain `const` here has been
 * initialised.
 */
const mocks = vi.hoisted(() => ({
  assign: vi.fn(),
  setLanguage: vi.fn(),
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
  useSetMeetingLanguageMutation: () => [
    (a: unknown) => {
      mocks.setLanguage(a);
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
 * publish, and it is one word away from the thing that does. "Change language"
 * must say, before the button, that it destroys every hand-typed correction on
 * the transcript; discovering that from a toast afterwards is discovering it too
 * late. And an operation with nothing to act on must not be offered at all: a
 * "Copy transcript" on a meeting whose transcript was erased is a menu item
 * that can only disappoint.
 */
function menu(over: Partial<React.ComponentProps<typeof MeetingMenu>> = {}) {
  const props = {
    meetingId: "mtg_1",
    projectId: null,
    spokenLanguage: null,
    detectedLanguage: "en",
    canExport: true,
    hasTranscript: true,
    hasSummary: true,
    canReprocess: true,
    canEraseAudio: true,
    canEraseTranscript: true,
    onExport: vi.fn(),
    onCopySummary: vi.fn(),
    onCopyMinutes: vi.fn(),
    onCopyTranscript: vi.fn(),
    onRegenerateSummary: vi.fn(),
    onRematchSpeakers: vi.fn(),
    onReprocess: vi.fn(),
    onEraseAudio: vi.fn(),
    onEraseTranscript: vi.fn(),
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
      "Export audio & text",
      "Move…",
      "Copy link",
      "Copy summary",
      "Copy formatted minutes",
      "Regenerate summary",
      "Copy transcript",
      "Rematch speakers",
      "Change language…",
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

  it("does not offer an export dialog that is not on the page yet", async () => {
    const user = userEvent.setup();
    menu({ canExport: false });
    await open(user);

    // A click that opens nothing looks exactly like one that failed.
    expect(
      screen.queryByRole("menuitem", { name: "Export audio & text" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer to erase what is already erased", async () => {
    const user = userEvent.setup();
    menu({ canEraseAudio: false, canEraseTranscript: false });
    await open(user);

    expect(
      screen.queryByRole("menuitem", { name: /Delete the recording/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Delete the transcript/ }),
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

  describe("Change language", () => {
    async function openLanguage(user: ReturnType<typeof userEvent.setup>) {
      await open(user);
      await user.click(screen.getByRole("menuitem", { name: "Change language…" }));
      return screen.getByRole("dialog");
    }

    it("says what it costs before the button that spends it", async () => {
      const user = userEvent.setup();
      menu();
      const dialog = await openLanguage(user);

      // Somebody who thought they were relabelling a field would otherwise find
      // out from a toast, after their corrections were gone.
      expect(within(dialog).getByText(/including any lines you corrected/)).toBeInTheDocument();
    });

    it("names what the transcriber thought it heard", async () => {
      const user = userEvent.setup();
      menu({ detectedLanguage: "en" });
      const dialog = await openLanguage(user);
      expect(within(dialog).getByText(/heard English/)).toBeInTheDocument();
    });

    it("sends the chosen language and re-transcribes", async () => {
      const user = userEvent.setup();
      menu();
      const dialog = await openLanguage(user);

      await user.click(within(dialog).getByRole("button", { name: /French/ }));
      await user.click(within(dialog).getByRole("button", { name: "Transcribe again" }));

      expect(mocks.setLanguage).toHaveBeenCalledWith({ id: "mtg_1", language: "fr" });
    });

    it("offers a way back to the account default", async () => {
      const user = userEvent.setup();
      menu({ spokenLanguage: "fr" });
      const dialog = await openLanguage(user);

      await user.click(within(dialog).getByRole("button", { name: /Use my account default/ }));
      await user.click(within(dialog).getByRole("button", { name: "Transcribe again" }));

      // Blank clears the override, so undoing a wrong answer does not require
      // knowing what the account setting says.
      expect(mocks.setLanguage).toHaveBeenCalledWith({ id: "mtg_1", language: "" });
    });

    it("opens on what was chosen last time, not on what was abandoned", async () => {
      const user = userEvent.setup();
      menu({ spokenLanguage: "fr" });
      const dialog = await openLanguage(user);

      expect(within(dialog).getByRole("button", { name: /French/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});
