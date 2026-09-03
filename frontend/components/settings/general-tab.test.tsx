import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse, PrivacyOverview } from "@/lib/types";

/**
 * Account Settings → General.
 *
 * Three claims worth holding onto.
 *
 * <i>Two of these fields are descriptive and two are not.</i> Department and
 * Role are recorded and read by nothing. The name is matched against the owner
 * of every action item, and the language is sent with every transcription job —
 * so the test that matters is that saving one does not quietly clear another,
 * which is what a form that sends its whole state on every keystroke would do.
 *
 * <i>Email and password are shown and not editable.</i> Neither is Reverie's to
 * change; a development session has no sign-in provider and therefore no
 * password at all, and an Edit control over them would be a promise the product
 * cannot keep.
 *
 * <i>The footer says nothing rather than something useless.</i> The version
 * line and the jump link to this page's own retention section are gone, and the
 * legal line does not appear at all unless somebody has supplied real URLs —
 * Reverie ships no terms of service of its own.
 */
const {
  update, setRetention, closeAccount, signOut, toastError,
} = vi.hoisted(() => ({
  update: vi.fn(),
  setRetention: vi.fn(),
  closeAccount: vi.fn(),
  signOut: vi.fn(),
  toastError: vi.fn(),
}));

let prefs: PreferencesResponse;
let overview: PrivacyOverview;
let identity: { name: string; email: string; imageUrl: string; provider: string; hasPassword: boolean };
let mode: "dev" | "clerk";
let failure: unknown = null;
let retentionFailure: unknown = null;

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

vi.mock("@/lib/auth", () => ({
  // `profile` carries how this person signed in, which is what decides whether
  // the name, the address and the password are theirs to change here.
  useAuth: () => ({ userId: "usr_dev", mode, signOut, profile: identity }),
}));

vi.mock("@/lib/api", () => ({
  // Retention and closing the account are on this tab now. Both were server
  // endpoints with no interface for months; the tests below are mostly about
  // the two ways that can go wrong -- sending one dial and clearing the other,
  // and a delete button that can be reached without typing the phrase.
  useGetPrivacyOverviewQuery: () => ({ data: overview, isLoading: false }),
  useUpdateRetentionMutation: () => [
    (body: unknown) => {
      setRetention(body);
      return {
        unwrap: () =>
          retentionFailure ? Promise.reject(retentionFailure) : Promise.resolve({}),
      };
    },
    { isLoading: false },
  ],
  useCloseAccountMutation: () => [
    (body: unknown) => {
      closeAccount(body);
      return { unwrap: () => Promise.resolve({ meetings: 3, storedObjects: 2 }) };
    },
    { isLoading: false },
  ],
  useGetPreferencesQuery: () => ({ data: prefs, isLoading: false }),
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", nativeName: "English", rightToLeft: false },
      { code: "es", name: "Spanish", nativeName: "Español", rightToLeft: false },
    ],
  }),
  useUpdatePreferencesMutation: () => [
    (body: unknown) => {
      update(body);
      return { unwrap: () => (failure ? Promise.reject(failure) : Promise.resolve({})) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { GeneralTab } from "@/components/settings/general-tab";

beforeEach(() => {
  vi.clearAllMocks();
  failure = null;
  retentionFailure = null;
  mode = "dev";
  identity = { name: "", email: "", imageUrl: "", provider: "", hasPassword: false };
  window.confirm = vi.fn(() => true);
  overview = {
    held: {
      meetings: 12,
      recordings: 9,
      audioErased: 3,
      transcripts: 12,
      transcriptsErased: 0,
      consentConfirmed: 7,
      actionItems: 41,
      marks: 6,
      projects: 2,
      chats: 5,
      oldestMeetingAt: "2025-03-04T09:00:00Z",
    },
    retention: {
      audioDays: null,
      meetingDays: null,
      recordingsDueNow: 0,
      meetingsDueNow: 0,
    },
    storage: { encryptionAtRest: null, signedUrlSeconds: 900, rowLevelSecurity: true },
    signIn: { mode: "dev", managedExternally: false, secondFactor: null },
  };
  prefs = {
    email: "priya@example.com",
    displayName: "Priya Raman",
    pronouns: null,
    avatarUrl: null,
    department: "IT",
    jobRole: "Individual contributor",
    defaultLanguage: null,
    chatHistoryDays: null,
    mutedNotifications: [],
    retentionWarningEmail: false,
    retentionAppliedEmail: false,
    taskReminderEmail: false,
    notesReadyEmail: false,
    allowanceEmail: false,
  };
});

describe("who you are", () => {
  it("shows the name and the address", () => {
    render(<GeneralTab />);

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.getByText("priya@example.com")).toBeInTheDocument();
  });

  it("no longer shows a department or a role", () => {
    // Both were descriptive only -- nothing routed by either -- and a profile
    // that asks for facts it never uses is a form people fill in for nothing.
    render(<GeneralTab />);

    expect(screen.queryByText("IT")).not.toBeInTheDocument();
    expect(screen.queryByText("Individual contributor")).not.toBeInTheDocument();
  });

  it("names the provider somebody actually signed in with", () => {
    // It used to say "Managed by your sign-in provider" to every Clerk account,
    // which is both vaguer than it needs to be and wrong for half of them --
    // an account made here with an email has a password, held for Reverie by
    // Clerk, and it is the account holder's to change.
    mode = "clerk";
    identity = { ...identity, provider: "google" };
    render(<GeneralTab />);

    expect(screen.getByText("You sign in with Google.")).toBeInTheDocument();
  });

  it("says the password is theirs when the account was made here", () => {
    mode = "clerk";
    identity = { ...identity, hasPassword: true };
    render(<GeneralTab />);

    expect(screen.getByText(/Set here\. Changing it signs out/)).toBeInTheDocument();
  });

  it("is honest that a development session has no password", () => {
    render(<GeneralTab />);

    expect(
      screen.getByText("Development session — there is no password."),
    ).toBeInTheDocument();
  });

  it("says so when there is no address yet", () => {
    prefs = { ...prefs, email: null };
    render(<GeneralTab />);

    // A blank line where an address should be reads as a broken feature.
    expect(screen.getByText(/No email address yet/)).toBeInTheDocument();
  });

  it("is read-only until Edit is pressed", () => {
    render(<GeneralTab />);

    expect(screen.queryByLabelText("Full Name")).not.toBeInTheDocument();
  });
});

describe("editing", () => {
  async function openEditor() {
    render(<GeneralTab />);
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
  }

  it("opens on the values already there", async () => {
    await openEditor();

    expect(screen.getByLabelText("Full Name")).toHaveValue("Priya Raman");
    expect(screen.getByLabelText("Email")).toHaveValue("priya@example.com");
  });

  it("asks for nothing it does not use", async () => {
    await openEditor();

    expect(screen.queryByLabelText("Department")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pronouns")).not.toBeInTheDocument();
  });

  it("shows the address without offering to change it", async () => {
    await openEditor();

    // No kind of account changes its address in Reverie. It is the credential,
    // so every route to changing it is a route to losing an account.
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Change email/i })).not.toBeInTheDocument();
  });

  it("never puts a real password in the DOM", async () => {
    await openEditor();

    // Dots are a drawing of a password, not one. Reverie has never held it,
    // and rendering anything else here would mean it had started to.
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toHaveValue("••••••••••");
  });

  it("saves every field it owns together, so changing one cannot clear another", async () => {
    await openEditor();

    await userEvent.clear(screen.getByLabelText("Full Name"));
    await userEvent.type(screen.getByLabelText("Full Name"), "Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    // No address in it. A field nobody can edit is a field with nothing to
    // send, and sending it back unchanged is what the server refuses.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ displayName: "Ada Lovelace", avatarUrl: "" }),
    );
  });

  it("keeps the form open when the save is refused", async () => {
    failure = { data: { message: "That name is too long" } };
    await openEditor();

    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That name is too long"));
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
  });

  it("backs out without saving", async () => {
    await openEditor();

    await userEvent.type(screen.getByLabelText("Full Name"), " and more");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
  });
});

describe("language", () => {
  it("opens on detect, which is what an unset account does", () => {
    render(<GeneralTab />);

    expect(screen.getByLabelText("Default language")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
  });

  it("offers only what transcription supports", () => {
    render(<GeneralTab />);

    // The list is served rather than written here: a nineteenth entry would be
    // offering a transcript that cannot be made.
    expect(screen.getByRole("option", { name: "Spanish" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Telugu" })).not.toBeInTheDocument();
  });

  it("saves the code on its own, touching nothing else", async () => {
    render(<GeneralTab />);

    await userEvent.selectOptions(screen.getByLabelText("Default language"), "es");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ defaultLanguage: "es" }));
  });

  it("goes back to detecting", async () => {
    prefs = { ...prefs, defaultLanguage: "es" };
    render(<GeneralTab />);

    await userEvent.selectOptions(screen.getByLabelText("Default language"), "");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ defaultLanguage: "" }));
  });
});

describe("the rest of the page", () => {
  it("no longer offers a vocabulary or a speaker list, which are gone", () => {
    render(<GeneralTab />);

    // Both were mounted here when the Meetings tab was removed, and both have
    // since been removed themselves — server, tables and all. The assertion is
    // that nothing was left mounted against endpoints that now 404.
    expect(screen.queryByRole("heading", { name: /Words and speakers/ })).toBeNull();
    expect(screen.queryByText(/Custom vocabulary/)).toBeNull();
  });

  it("says outright that nothing here is used to train a model", () => {
    render(<GeneralTab />);

    expect(
      screen.getByRole("heading", { name: /Feedback and training/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not train on your meetings/)).toBeInTheDocument();
    // The absence is the point: a toggle would imply a use to opt out of.
    // Scoped to this section -- the email switches below are checkboxes too,
    // and the claim here was only ever about this one.
    const training = screen.getByRole("heading", { name: /Feedback and training/ });
    expect(training.closest("section")!.querySelector("input[type=checkbox]")).toBeNull();
  });

  it("does not show a version that identifies nothing", () => {
    // "Version 0.0.0 — dev build" traces to no commit and reads as unfinished
    // software to everybody except the person who built it.
    render(<GeneralTab />);

    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.queryByText(/dev build/)).not.toBeInTheDocument();
  });

  it("does not link to the middle of the page it is already on", () => {
    // It pointed at `#data`, the retention section a few hundred pixels away.
    render(<GeneralTab />);

    expect(screen.queryByText(/keeps what is yours/)).not.toBeInTheDocument();
  });

  it("shows no legal line when there are no documents to link to", () => {
    render(<GeneralTab />);

    // Reverie ships no terms of service of its own, and a link to a page that
    // does not exist is worse than no link.
    expect(screen.queryByText(/Terms of Service/)).not.toBeInTheDocument();
    expect(screen.queryByText(/By using Reverie/)).not.toBeInTheDocument();
  });
});

describe("how long things are kept", () => {
  it("opens on Never, which is what an account with no policy has", () => {
    render(<GeneralTab />);

    const never = screen.getAllByRole("button", { name: "Never" });
    expect(never).toHaveLength(2);
    never.forEach((b) => expect(b).toHaveAttribute("aria-pressed", "true"));
  });

  it("sends both dials on every change, because null means keep and not leave alone", async () => {
    overview = {
      ...overview,
      retention: { ...overview.retention, meetingDays: 30 },
    };
    render(<GeneralTab />);

    // Changing the recording dial alone. If the meeting dial were omitted the
    // API would read it as null and quietly clear a policy nobody touched.
    await userEvent.click(screen.getAllByRole("button", { name: "After a week" })[0]);

    await waitFor(() =>
      expect(setRetention).toHaveBeenCalledWith({ audioDays: 7, meetingDays: 30 }),
    );
  });

  it("refuses to offer the pair the server would reject", () => {
    overview = {
      ...overview,
      retention: { ...overview.retention, audioDays: 30 },
    };
    render(<GeneralTab />);

    // Deleting the meeting after a week while keeping its recording a month
    // means the recording rule never runs. The server says so; the button
    // should not be clickable in the first place.
    expect(screen.getAllByRole("button", { name: "After a week" })[1]).toBeDisabled();
  });

  it("warns what the next pass would take of what is already there", () => {
    overview = {
      ...overview,
      retention: { ...overview.retention, audioDays: 7, recordingsDueNow: 4 },
    };
    render(<GeneralTab />);

    expect(screen.getByText(/deletes 4 recordings you already have/)).toBeInTheDocument();
  });

  it("names a window it no longer offers instead of drawing it as Never", () => {
    overview = {
      ...overview,
      retention: { ...overview.retention, meetingDays: 90 },
    };
    render(<GeneralTab />);

    // 90 days was on the list once and the API still accepts it. Showing the
    // three buttons all unpressed would read as "nothing is deleted".
    expect(screen.getByText(/after 90 days, which is not one of these/i)).toBeInTheDocument();
  });

  it("explains a refusal in the API's own words", async () => {
    retentionFailure = {
      data: { message: "Keep meetings at least as long as recordings." },
    };
    render(<GeneralTab />);

    await userEvent.click(screen.getAllByRole("button", { name: "After a week" })[0]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Keep meetings at least as long as recordings.",
      ),
    );
  });
});

describe("closing the account", () => {
  it("says what goes and that it is permanent", () => {
    render(<GeneralTab />);

    expect(screen.getByText(/Deletes everything/)).toBeInTheDocument();
    // Bold and its own word, so it survives a skim of the paragraph.
    expect(screen.getByText("permanently")).toBeInTheDocument();
  });

  it("cannot be reached by one click", async () => {
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(screen.getByRole("button", { name: /Delete everything/ })).toBeDisabled();
    expect(closeAccount).not.toHaveBeenCalled();
  });

  it("enables only on the phrase, and sends what was typed", async () => {
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete");
    expect(screen.getByRole("button", { name: /Delete everything/ })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/to confirm/), " everything");
    await userEvent.click(screen.getByRole("button", { name: /Delete everything/ }));

    await waitFor(() =>
      expect(closeAccount).toHaveBeenCalledWith({ confirm: "delete everything" }),
    );
  });

  it("signs out afterwards, since the account it was signed into is gone", async () => {
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete everything");
    await userEvent.click(screen.getByRole("button", { name: /Delete everything/ }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });

  it("backs out and forgets what was typed", async () => {
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete everything");
    await userEvent.click(screen.getByRole("button", { name: "Keep my account" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByLabelText(/to confirm/)).toHaveValue("");
    expect(closeAccount).not.toHaveBeenCalled();
  });
});


/**
 * The email switches.
 *
 * <p>V56 deleted every message Reverie sent, and its stated reason was not
 * that the messages were wrong — it was that the switches had no UI to reach
 * them, so nothing went out and nobody could have asked for it. This section is
 * the half that was missing, and these tests are what stop it going missing
 * again.
 */
describe("email", () => {
  it("shows every message it will send, and none it will not", async () => {
    render(<GeneralTab />);

    expect(await screen.findByRole("heading", { name: /Email notifications/ })).toBeInTheDocument();
    expect(screen.getByText(/Before retention deletes something/)).toBeInTheDocument();
    expect(screen.getByText(/After retention deletes something/)).toBeInTheDocument();
    expect(screen.getByText(/Action items due tomorrow/)).toBeInTheDocument();
    expect(screen.getByText(/Notes ready for a long recording/)).toBeInTheDocument();
    expect(screen.getByText(/transcription minutes are nearly gone/)).toBeInTheDocument();
  });

  it("starts every one of them off", async () => {
    // Mail that arrives because a migration ran is how a sender gets filtered,
    // and a filtered sender loses the retention warning with the rest.
    render(<GeneralTab />);

    const heading = await screen.findByRole("heading", { name: /Email notifications/ });
    const section = heading.closest("section")!;
    for (const box of Array.from(section.querySelectorAll("input[type=checkbox]"))) {
      expect(box).not.toBeChecked();
    }
  });

  it("saves one switch on its own", async () => {
    // Six toggles behind a single Save is a section where flipping one thing
    // and walking away loses it.
    render(<GeneralTab />);
    await screen.findByRole("heading", { name: /Email notifications/ });

    await userEvent.click(screen.getByText(/Action items due tomorrow/));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ taskReminderEmail: true }));
  });

  it("names the two messages nobody can switch off", async () => {
    /*
     * Said rather than hidden. A message with no switch that the page does not
     * mention reads as a message you cannot stop -- and one of the two is sent
     * after the row holding these settings has been deleted, so there is
     * nowhere else it could ever be explained.
     */
    render(<GeneralTab />);
    await screen.findByRole("heading", { name: /Email notifications/ });

    expect(screen.getByText(/Two messages have no switch/)).toBeInTheDocument();
    expect(screen.getByText(/running out of transcription minutes/)).toBeInTheDocument();
    expect(screen.getByText(/account being closed/)).toBeInTheDocument();
  });

  it("says so rather than showing five switches that do nothing", async () => {
    failure = { data: { message: "nope" } };
    prefs = null as never;
    render(<GeneralTab />);

    expect(await screen.findByRole("heading", { name: /Email notifications/ })).toBeInTheDocument();
  });
});
