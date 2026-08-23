import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
 * <p>Nothing else is ever absent. An item with nothing to act on is greyed and
 * stays where it was, so the menu is the same eight lines on every meeting;
 * `data-disabled` is Radix's mark for that, and it is asserted rather than
 * inferred from a click, because a disabled item takes no pointer events and a
 * click on one proves only that nothing happened.
 *
 * <p>Two items that used to be here are asserted absent by name. "Transcribe
 * again" re-ran the pipeline over the same audio and threw away every hand
 * correction and speaker rename to do it. And "Change language…" — a different
 * item, now a reused name — did the same thing while sounding like the
 * translation picker it sat next to. The name is back on the picker; what must
 * not come back is either of them re-transcribing.
 */
function menu(over: Partial<React.ComponentProps<typeof MeetingMenu>> = {}) {
  const props = {
    meetingId: "mtg_1",
    projectId: null,
    hasTranscript: true,
    hasSummary: true,
    canTranslate: true,
    onCopySummary: vi.fn(),
    onCopyTranscript: vi.fn(),
    onRegenerateSummary: vi.fn(),
    onTranslate: vi.fn(),
    onRematchSpeakers: vi.fn(),
    onFixDiarization: vi.fn(),
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
      "Copy transcript",
      "Rematch speakers",
      "Fix diarization",
      "Change language",
      "Copy summary",
      "Regenerate summary",
      "Delete this meeting",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("keeps the transcript's own actions together, and above the brief's", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // The order is the argument: the summary is written from the transcript, so
    // correcting a speaker or switching language comes first and Regenerate is
    // what you reach for afterwards. Asserted as a whole sequence because the
    // grouping is the thing being pinned, and a single item drifting one line
    // up puts it in the wrong group without failing any other test here.
    expect(
      screen.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
    ).toEqual([
      "Move…",
      "Copy link",
      "Copy transcript",
      "Rematch speakers",
      "Fix diarization",
      "Change language",
      "Copy summary",
      "Regenerate summary",
      "Delete this meeting",
    ]);
  });

  it("survives the window losing focus", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // Switching browser tabs, or alt-tabbing away, blurs the window — and
    // Radix's menu root closes on that. Nobody dismissed anything; they looked
    // away, and came back to a menu they had not closed. jsdom always reports
    // the document as focused, so the unfocused window is the part stubbed.
    // The fix is on DropdownMenu, so every menu in the app behaves this way;
    // this is the one it was reported on.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(window);

    expect(screen.getByRole("menuitem", { name: "Delete this meeting" })).toBeInTheDocument();
    hasFocus.mockRestore();
  });

  it("still closes on a click outside it", async () => {
    const user = userEvent.setup();
    menu();
    await open(user);

    // The other half. Declining one close must not decline them all — and the
    // window is focused for this one, which is exactly what tells them apart.
    // Fired rather than clicked because an open modal menu sets pointer-events
    // to none on everything behind it, which user-event refuses to click.
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menuitem", { name: "Delete this meeting" })).not.toBeInTheDocument();
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
    // And specifically NOT the one that opens the merge dropdowns. This is the
    // whole change: the item used to scroll to a form, which is not what
    // "rematch" means anywhere else and is not what somebody clicking it wants.
    expect(props.onFixDiarization).not.toHaveBeenCalled();

    // This one alone leaves the menu open, so it has to be closed by hand
    // before the next item can be reached. That is deliberate and is asserted
    // properly two tests down: the operation takes a few seconds and reports
    // itself on the item, and a menu that vanished on click would take the
    // spinner with it.
    await user.keyboard("{Escape}");

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Change language" }));
    expect(props.onTranslate).toHaveBeenCalled();
  });

  it("keeps the manual repair, under a name that says what it does", async () => {
    const user = userEvent.setup();
    const props = menu();

    await open(user);
    await user.click(screen.getByRole("menuitem", { name: "Fix diarization" }));

    // Merging two labels and moving a stray turn did not stop being necessary
    // when Rematch became automatic — they answer a different question, and no
    // amount of voice matching fixes one person split across two labels.
    expect(props.onFixDiarization).toHaveBeenCalled();
    expect(props.onRematchSpeakers).not.toHaveBeenCalled();
  });

  it("says a rematch is running, on the item that started it", async () => {
    const user = userEvent.setup();
    menu({ rematching: true });
    await open(user);

    // A few seconds of nothing is indistinguishable from a click that missed,
    // and this item has no other place to report itself — it opens no dialog
    // and moves the page nowhere.
    expect(
      screen.getByRole("menuitem", { name: "Rematching speakers…" }),
    ).toHaveAttribute("data-disabled");
  });

  it("does not disable the manual repair while a rematch runs", async () => {
    const user = userEvent.setup();
    menu({ rematching: true });
    await open(user);

    // They do not collide: one renames unresolved speakers by voice, the other
    // opens a form. Greying the second would be borrowing a restriction from
    // the first for no reason the reader can see.
    expect(
      screen.getByRole("menuitem", { name: "Fix diarization" }),
    ).not.toHaveAttribute("data-disabled");
  });

  it("greys the reading language for a meeting with nothing written yet", async () => {
    const user = userEvent.setup();
    menu({ canTranslate: false });
    await open(user);

    expect(screen.getByRole("menuitem", { name: "Change language" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("offers nothing that re-runs the transcriber", async () => {
    const user = userEvent.setup();
    const props = menu();
    await open(user);

    // "Transcribe again" bought the same pipeline over the same audio for the
    // price of every correction and speaker rename anybody had made.
    expect(screen.queryByRole("menuitem", { name: /Transcribe again/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /re-?transcribe/i })).not.toBeInTheDocument();

    // And the item that says "language" translates. An earlier item of that
    // exact name re-transcribed from the audio, which is why this one spent a
    // while called "Read in another language…" — the name is only safe now
    // because the destructive one is gone, so what it does is asserted here.
    await user.click(screen.getByRole("menuitem", { name: "Change language" }));
    expect(props.onTranslate).toHaveBeenCalled();
  });

  it("greys what a meeting with nothing in it cannot do, and keeps it in place", async () => {
    const user = userEvent.setup();
    menu({ hasTranscript: false, hasSummary: false, canTranslate: false });
    await open(user);

    // Greyed rather than gone. A menu five lines long on one meeting and eight
    // on the next has to be read from the top every time, and "there is no
    // transcript" and "there is no transcript yet" look identical when the
    // difference is an item that is simply missing.
    for (const label of [
      "Copy transcript",
      "Rematch speakers",
      "Fix diarization",
      "Change language",
      "Copy summary",
      "Regenerate summary",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-disabled");
    }

    // The three that never needed a transcript stay live — deleting it is the
    // commonest thing to want to do with a meeting that has nothing in it.
    for (const label of ["Move…", "Copy link", "Delete this meeting"]) {
      expect(screen.getByRole("menuitem", { name: label })).not.toHaveAttribute("data-disabled");
    }
  });

  it("greys the three that act while one of them is still running", async () => {
    const user = userEvent.setup();
    menu({ working: true });
    await open(user);

    // Rematching, changing language and regenerating all end in the summary
    // being rewritten. Two of those racing on one meeting is the concrete thing
    // this prevents.
    for (const label of ["Rematch speakers", "Change language", "Regenerate summary"]) {
      expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-disabled");
    }

    // Copying is not one of them: taking what is on screen is safe whatever is
    // happening behind it, and refusing it mid-rewrite would be a menu that
    // goes dead for no reason the reader can see.
    for (const label of ["Copy transcript", "Copy summary", "Copy link"]) {
      expect(screen.getByRole("menuitem", { name: label })).not.toHaveAttribute("data-disabled");
    }
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
      await user.click(screen.getByRole("button", { name: /No folder/ }));

      expect(mocks.assign).toHaveBeenCalledWith({ meetingId: "mtg_1", projectId: null });
    });
  });
});
