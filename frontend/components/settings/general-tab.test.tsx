import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse, PrivacyOverview, SpeakerSettings } from "@/lib/types";

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
 * <i>Email and password are shown and not editable.</i> Neither is Recallix's to
 * change; a development session has no sign-in provider and therefore no
 * password at all, and an Edit control over them would be a promise the product
 * cannot keep.
 *
 * <i>Nothing in the footer is invented.</i> No commit means "dev build" rather
 * than a hash that resolves to nothing, and the legal line does not appear at
 * all unless somebody has supplied real URLs — Recallix ships no terms of
 * service of its own.
 */
const {
  update, setRetention, closeAccount, signOut, toastError,
  setSpeakerLearning, deleteSpeakerProfile,
} = vi.hoisted(() => ({
  update: vi.fn(),
  setRetention: vi.fn(),
  closeAccount: vi.fn(),
  signOut: vi.fn(),
  toastError: vi.fn(),
  setSpeakerLearning: vi.fn(),
  deleteSpeakerProfile: vi.fn(),
}));

let prefs: PreferencesResponse;
let overview: PrivacyOverview;
let mode: "dev" | "clerk";
let speakers: SpeakerSettings;
let failure: unknown = null;
let retentionFailure: unknown = null;

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_dev", mode, signOut }),
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
  // Voice recognition. Its own endpoints rather than a field on /preferences,
  // because switching it off *deletes* every voice template the account holds
  // and that must not be reachable from a null-means-unchanged bulk patch.
  useGetSpeakerSettingsQuery: () => ({ data: speakers, isLoading: false }),
  useSetSpeakerLearningMutation: () => [
    (enabled: boolean) => {
      setSpeakerLearning(enabled);
      return { unwrap: () => Promise.resolve({ learningEnabled: enabled, profiles: [] }) };
    },
    { isLoading: false },
  ],
  useDeleteSpeakerProfileMutation: () => [
    (id: string) => {
      deleteSpeakerProfile(id);
      return { unwrap: () => Promise.resolve() };
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
  speakers = { learningEnabled: false, profiles: [] };
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
    autoEmailRecap: false,
    recapEmail: null,
    effectiveRecapEmail: "priya@example.com",
    displayName: "Priya Raman",
    pronouns: null,
    avatarUrl: null,
    department: "IT",
    jobRole: "Individual contributor",
    defaultLanguage: null,
    chatHistoryDays: null,
    taskReminders: false,
    weeklyDigest: false,
    emailsEnabled: true,
    recapForImports: false,
    commentEmail: false,
    highlightEmail: false,
    mutedNotifications: [],
  };
});

describe("who you are", () => {
  it("shows the name, address, department and role", () => {
    render(<GeneralTab />);

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.getByText("priya@example.com")).toBeInTheDocument();
    expect(screen.getByText("IT")).toBeInTheDocument();
    expect(screen.getByText("Individual contributor")).toBeInTheDocument();
  });

  it("says where the password lives rather than pretending to hold one", () => {
    mode = "clerk";
    render(<GeneralTab />);

    expect(screen.getByText("Managed by your sign-in provider.")).toBeInTheDocument();
  });

  it("is honest that a development session has no password", () => {
    render(<GeneralTab />);

    expect(
      screen.getByText("Development session — there is no password."),
    ).toBeInTheDocument();
  });

  it("says so when the provider gave no address", () => {
    prefs = { ...prefs, email: null };
    render(<GeneralTab />);

    // Dev sessions have no provider, and "no email" reads as a broken feature
    // unless the page says why.
    expect(screen.getByText(/No address from your sign-in provider/)).toBeInTheDocument();
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
    expect(screen.getByLabelText("Department")).toHaveValue("IT");
    expect(screen.getByLabelText("Role")).toHaveValue("Individual contributor");
  });

  it("shows the two it cannot change, and refuses to let them be edited", async () => {
    await openEditor();

    // Shown, because a profile that omits your own address reads as broken.
    // Disabled, because Recallix does not hold either: the address is the
    // sign-in provider's fact and the password is only ever Clerk's. An
    // editable box would be a control that silently does nothing.
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
  });

  it("never puts a real password in the DOM", async () => {
    await openEditor();

    // Dots are a drawing of a password, not one. Recallix has never held it,
    // and rendering anything else here would mean it had started to.
    expect(screen.getByLabelText("Password")).toHaveValue("••••••••••");
  });

  it("saves every field together, so changing one cannot clear another", async () => {
    await openEditor();

    await userEvent.selectOptions(screen.getByLabelText("Department"), "Engineering");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        displayName: "Priya Raman",
        pronouns: "",
        department: "Engineering",
        jobRole: "Individual contributor",
        avatarUrl: "",
      }),
    );
  });

  it("keeps a department that is not on the list", async () => {
    // Both fields were free text before the pickers existed. A select whose
    // value is absent from its options renders the first option instead, so
    // opening this to change a photo would silently rewrite somebody\'s
    // department -- data loss with no prompt and no undo.
    prefs = { ...prefs, department: "Platform Engineering" };
    await openEditor();

    expect(screen.getByLabelText("Department")).toHaveValue("Platform Engineering");
  });

  it("records pronouns rather than inferring them", async () => {
    await openEditor();

    await userEvent.type(screen.getByLabelText("Pronouns"), "they/them");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ pronouns: "they/them" }),
      ),
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
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("names the build rather than inventing one", () => {
    render(<GeneralTab />);

    expect(screen.getByText(/^Version /)).toHaveTextContent("dev build");
  });

  it("shows no legal line when there are no documents to link to", () => {
    render(<GeneralTab />);

    // Recallix ships no terms of service of its own, and a link to a page that
    // does not exist is worse than no link.
    expect(screen.queryByText(/Terms of Service/)).not.toBeInTheDocument();
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
  it("says the size of what goes, because the number is the warning", () => {
    render(<GeneralTab />);

    expect(screen.getByText(/Deletes 12 meetings, 9 recordings/)).toBeInTheDocument();
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
 * Voice recognition ~ the only consent on this page, and the only data on it
 * that is derived from somebody's body.
 *
 * <p>Matching a voice across meetings cannot be done from names. Recallix held a
 * list of names for a year and it could never have identified anybody: it needs
 * a numerical description of how a person sounds, which is a stable identifier
 * and, under GDPR Article 9, biometric data when used to identify someone.
 *
 * <p>So this section is held to a different standard from the toggles around it,
 * and these are the four things that have to be true of it: off unless asked
 * for, described before it is agreed to, visible once it holds anything, and
 * removable ~ where "removable" means the data goes, not just its use.
 */
describe("voice recognition", () => {
  it("is off until the account holder turns it on", () => {
    render(<GeneralTab />);

    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    // No list at all while it is off. There is nothing held to show, and a
    // "Saved voices (0)" heading would imply this is somewhere data collects.
    expect(screen.queryByText(/Saved voices/i)).toBeNull();
  });

  it("says what the data is before asking for it", async () => {
    render(<GeneralTab />);

    // The sentence that makes this a decision rather than a switch. A user who
    // reads "recognise people you have named" and nothing else has not been
    // told that a description of their colleagues' voices is being stored.
    expect(screen.getByText(/This is voice data/i)).toBeInTheDocument();
    expect(screen.getByText(/stored encrypted/i)).toBeInTheDocument();
    expect(screen.getByText(/never used to train anything/i)).toBeInTheDocument();
    expect(screen.getByText(/turning it off again deletes everything below/i))
      .toBeInTheDocument();
  });

  it("turns on without asking, because nothing is stored yet", async () => {
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));

    // A profile appears the first time you name somebody, not now. A confirm
    // here would be ceremony over an act with no consequence yet.
    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(setSpeakerLearning).toHaveBeenCalledWith(true));
  });

  it("lists what is held, and how thin each one is", () => {
    speakers = {
      learningEnabled: true,
      profiles: [
        { id: "spf_1", name: "Sarah", samples: 4, createdAt: "", updatedAt: "" },
        { id: "spf_2", name: "Tom", samples: 1, createdAt: "", updatedAt: "" },
      ],
    };
    render(<GeneralTab />);

    expect(screen.getByText("Sarah")).toBeInTheDocument();
    // The sample count is the only thing that makes "why did it match?"
    // actionable: a voice built from one appearance is one worth deleting.
    expect(screen.getByText("From 4 meetings")).toBeInTheDocument();
    expect(screen.getByText("From 1 meeting")).toBeInTheDocument();
  });

  it("says plainly that there is nothing held yet, rather than showing an empty box", () => {
    speakers = { learningEnabled: true, profiles: [] };
    render(<GeneralTab />);

    expect(screen.getByText(/None yet/i)).toBeInTheDocument();
  });

  it("deletes one voice on request", async () => {
    speakers = {
      learningEnabled: true,
      profiles: [{ id: "spf_1", name: "Sarah", samples: 4, createdAt: "", updatedAt: "" }],
    };
    render(<GeneralTab />);

    await userEvent.click(
      screen.getByRole("button", { name: "Delete the saved voice for Sarah" }),
    );

    await waitFor(() => expect(deleteSpeakerProfile).toHaveBeenCalledWith("spf_1"));
  });

  it("says how much is about to be destroyed before switching off", async () => {
    speakers = {
      learningEnabled: true,
      profiles: [
        { id: "spf_1", name: "Sarah", samples: 4, createdAt: "", updatedAt: "" },
        { id: "spf_2", name: "Tom", samples: 1, createdAt: "", updatedAt: "" },
      ],
    };
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));

    // Off deletes; it does not pause. Somebody expecting the second would find
    // their saved voices gone, so the count goes in the question.
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("deletes 2 saved voices"),
    );
    await waitFor(() => expect(setSpeakerLearning).toHaveBeenCalledWith(false));
  });

  it("does nothing at all if the warning is declined", async () => {
    window.confirm = vi.fn(() => false);
    speakers = {
      learningEnabled: true,
      profiles: [{ id: "spf_1", name: "Sarah", samples: 4, createdAt: "", updatedAt: "" }],
    };
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));

    expect(setSpeakerLearning).not.toHaveBeenCalled();
  });

  it("never sends voice learning through the preferences patch", async () => {
    speakers = { learningEnabled: true, profiles: [] };
    render(<GeneralTab />);

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));

    // The separation is the safeguard, not a tidiness preference: every other
    // control here sends a partial patch whenever anything on the page moves,
    // and a destructive field riding along in one of those would eventually
    // delete somebody's voices as a side effect of renaming their department.
    await waitFor(() => expect(setSpeakerLearning).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it("shows no accuracy figure anywhere", () => {
    speakers = {
      learningEnabled: true,
      profiles: [{ id: "spf_1", name: "Sarah", samples: 4, createdAt: "", updatedAt: "" }],
    };
    const { container } = render(<GeneralTab />);

    // The matcher thresholds on cosine similarity, which is not a calibrated
    // probability. "94% match" would be a precision it never computed, and it
    // would invite somebody to accept a 68% one.
    expect(container.textContent).not.toMatch(/\d+% (match|confiden|accura)/i);
  });
});
