import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrivacyOverview } from "@/lib/types";

/**
 * The Security tab — what was the privacy page.
 *
 * <p>Nearly every test here is about a sentence being true rather than about a
 * control working. The page's whole value is that somebody uneasy about what a
 * meeting recorder has of theirs can read it and believe it, which means the
 * encryption line has to be able to say no, the shared-links list has to name
 * what each link actually reveals, and the retention dial has to say how much of
 * what they already have it would delete tonight — before they set it, not the
 * morning after.
 *
 * <p>The rest are about the one button that cannot be undone being genuinely
 * hard to press by accident, and impossible to press without having been told
 * what it does.
 */
const { updateRetention, revokeAll, closeAccount, downloadArchive, signOut } = vi.hoisted(() => ({
  updateRetention: vi.fn(),
  revokeAll: vi.fn(),
  closeAccount: vi.fn(),
  downloadArchive: vi.fn(),
  signOut: vi.fn(),
}));

let overview: PrivacyOverview;
let revokedCount: number;

vi.mock("@/lib/api", () => ({
  useGetPrivacyOverviewQuery: () => ({ data: overview, isLoading: false }),
  useUpdateRetentionMutation: () => [
    (arg: unknown) => {
      updateRetention(arg);
      return { unwrap: () => Promise.resolve(overview.retention) };
    },
    { isLoading: false },
  ],
  useRevokeAllLinksMutation: () => [
    () => {
      revokeAll();
      return { unwrap: () => Promise.resolve({ revoked: revokedCount }) };
    },
    { isLoading: false },
  ],
  useCloseAccountMutation: () => [
    (arg: unknown) => {
      closeAccount(arg);
      return { unwrap: () => Promise.resolve({ meetings: 5, storedObjects: 4 }) };
    },
    { isLoading: false },
  ],
}));

vi.mock("@/lib/exports", () => ({
  downloadAccountArchive: () => {
    downloadArchive();
    return Promise.resolve();
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_1", mode: "dev", signOut }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { SecurityTab as PrivacyPage } from "@/components/settings/security-tab";

function anOverview(patch: Partial<PrivacyOverview> = {}): PrivacyOverview {
  return {
    held: {
      meetings: 5,
      recordings: 4,
      audioErased: 0,
      transcripts: 5,
      transcriptsErased: 0,
      actionItems: 12,
      marks: 3,
      projects: 2,
      chats: 7,
      consentConfirmed: 2,
      oldestMeetingAt: "2026-01-04T09:00:00Z",
      ...(patch.held ?? {}),
    },
    retention: {
      audioDays: null,
      meetingDays: null,
      recordingsDueNow: 0,
      meetingsDueNow: 0,
      ...(patch.retention ?? {}),
    },
    storage: {
      encryptionAtRest: null,
      signedUrlSeconds: 900,
      rowLevelSecurity: true,
      ...(patch.storage ?? {}),
    },
    signIn: {
      mode: "dev",
      managedExternally: false,
      secondFactor: null,
      ...(patch.signIn ?? {}),
    },
    liveLinks: patch.liveLinks ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  revokedCount = 0;
  overview = anOverview();
});

describe("what Recallix has", () => {
  it("counts the things somebody would actually ask about", () => {
    render(<PrivacyPage />);

    expect(screen.getByText("Meetings").parentElement).toHaveTextContent("5");
    expect(screen.getByText("Recordings").parentElement).toHaveTextContent("4");
    expect(screen.getByText("Action items").parentElement).toHaveTextContent("12");
  });

  it("says what has already been erased, so the counts are not mistaken for everything", () => {
    overview = anOverview({
      held: { ...anOverview().held, audioErased: 2, transcriptsErased: 1 },
    });

    render(<PrivacyPage />);

    expect(screen.getByText(/You have erased/)).toBeInTheDocument();
    expect(screen.getByText("2 recordings")).toBeInTheDocument();
    expect(screen.getByText("1 transcript")).toBeInTheDocument();
  });

  it("distinguishes what was recorded here from what arrived some other way", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByText(/2 of these were recorded here/),
    ).toBeInTheDocument();
  });
});

describe("how it is stored", () => {
  it("declines to claim encryption the bucket does not apply", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/applies no encryption at rest/)).toBeInTheDocument();
  });

  it("repeats the algorithm the bucket reports, when it reports one", () => {
    overview = anOverview({
      storage: { encryptionAtRest: "AES256", signedUrlSeconds: 900, rowLevelSecurity: true },
    });

    render(<PrivacyPage />);

    expect(screen.getByText("AES256")).toBeInTheDocument();
    expect(screen.queryByText(/applies no encryption/)).not.toBeInTheDocument();
  });

  it("says how long a signed link lasts, in minutes a person can hold in their head", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/stops working after 15 minutes/)).toBeInTheDocument();
  });

  it("says plainly that there is no bot, because that is the claim competitors make", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/never joins a call/)).toBeInTheDocument();
  });
});

describe("shared links", () => {
  const link = {
    id: "shr_1",
    meetingId: "mtg_1",
    meetingTitle: "Sprint planning",
    url: "https://recallix.test/shared/tok",
    label: "",
    reveals: ["summary", "transcript"],
    moment: false,
    passwordProtected: true,
    expiresAt: null,
    viewCount: 3,
    lastViewedAt: "2026-08-10T09:00:00Z",
    createdAt: "2026-08-01T09:00:00Z",
  };

  it("says nothing is shared when nothing is, rather than showing an empty list", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/Meetings are private until you publish a link/)).toBeInTheDocument();
  });

  it("names the meeting and what the link lets a stranger read", () => {
    overview = anOverview({ liveLinks: [link] });

    render(<PrivacyPage />);

    expect(screen.getByText("Sprint planning")).toBeInTheDocument();
    expect(screen.getByText(/Shows summary, transcript/)).toBeInTheDocument();
    expect(screen.getByText(/opened 3 times/)).toBeInTheDocument();
    expect(screen.getByText("password")).toBeInTheDocument();
  });

  it("says when a link never expires, rather than leaving the absence to be noticed", () => {
    overview = anOverview({ liveLinks: [link] });

    render(<PrivacyPage />);

    expect(screen.getByText(/no expiry/)).toBeInTheDocument();
  });

  it("asks before withdrawing everything, and says what withdrawing means", async () => {
    overview = anOverview({ liveLinks: [link] });
    revokedCount = 1;
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getByRole("button", { name: /withdraw every link/i }));

    expect(screen.getByText(/stops being able to open it/)).toBeInTheDocument();
    expect(revokeAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^withdraw all$/i }));
    await waitFor(() => expect(revokeAll).toHaveBeenCalled());
  });
});

describe("how long it is kept", () => {
  it("starts on Keep, which is what every account has been doing", () => {
    render(<PrivacyPage />);

    const keeps = screen.getAllByRole("button", { name: "Keep" });
    expect(keeps).toHaveLength(2);
    keeps.forEach((b) => expect(b).toHaveAttribute("aria-pressed", "true"));
  });

  it("sends both dials, so a stale render cannot change the one nobody touched", async () => {
    overview = anOverview({
      retention: { audioDays: null, meetingDays: 365, recordingsDueNow: 0, meetingsDueNow: 0 },
    });
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getAllByRole("button", { name: "30 days" })[0]);

    await waitFor(() =>
      expect(updateRetention).toHaveBeenCalledWith({ audioDays: 30, meetingDays: 365 }),
    );
  });

  it("warns how much of what you already have tonight's pass would take", () => {
    overview = anOverview({
      retention: { audioDays: 7, meetingDays: null, recordingsDueNow: 43, meetingsDueNow: 0 },
    });

    render(<PrivacyPage />);

    expect(screen.getByText(/deletes 43 recordings you already have/)).toBeInTheDocument();
  });

  it("says nothing about tonight when nothing is old enough for it", () => {
    render(<PrivacyPage />);

    expect(screen.queryByText(/Tonight this deletes/)).not.toBeInTheDocument();
  });
});

describe("taking it away", () => {
  it("says what is in the archive and what deliberately is not", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/all 5 meetings twice over/)).toBeInTheDocument();
    expect(screen.getByText(/recordings are not in it/)).toBeInTheDocument();
  });

  it("downloads through the API rather than a link that could be shared by accident", async () => {
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getByRole("button", { name: /download my data/i }));

    await waitFor(() => expect(downloadArchive).toHaveBeenCalled());
  });
});

describe("closing the account", () => {
  it("says how much is about to go, and that nothing is held back", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/Deletes 5 meetings, 4 recordings/)).toBeInTheDocument();
    expect(screen.getByText(/Immediately, and with no way back/)).toBeInTheDocument();
  });

  it("will not delete until the phrase has been typed exactly", async () => {
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getByRole("button", { name: /close account/i }));

    const confirm = screen.getByRole("button", { name: /delete everything/i });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type/i), "yes please");
    expect(screen.getByRole("button", { name: /delete everything/i })).toBeDisabled();
    expect(closeAccount).not.toHaveBeenCalled();
  });

  it("deletes, then signs out, because there is no account left to be signed into", async () => {
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getByRole("button", { name: /close account/i }));
    await user.type(screen.getByLabelText(/type/i), "delete everything");
    await user.click(screen.getByRole("button", { name: /delete everything/i }));

    await waitFor(() => expect(closeAccount).toHaveBeenCalledWith({ confirm: "delete everything" }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });

  it("lets somebody back out without having deleted anything", async () => {
    const user = userEvent.setup();

    render(<PrivacyPage />);
    await user.click(screen.getByRole("button", { name: /close account/i }));
    await user.click(screen.getByRole("button", { name: /keep my account/i }));

    expect(screen.queryByLabelText(/type/i)).not.toBeInTheDocument();
    expect(closeAccount).not.toHaveBeenCalled();
  });
});

/**
 * Two-factor authentication.
 *
 * <p>Recallix never sees a sign-in — it verifies a token Clerk issued — so this
 * card reports and points rather than enrolling anything. The tests are mostly
 * about the three-valued status: "the provider said off" and "the provider said
 * nothing" are different, and collapsing the second into the first would tell
 * somebody who has 2FA switched on that they do not.
 */
describe("two-factor authentication", () => {
  it("explains itself in terms of signing in, not of Recallix", () => {
    render(<PrivacyPage />);

    expect(screen.getByText("Two-factor Authentication")).toBeInTheDocument();
    expect(screen.getByText(/a stolen password is not enough/i)).toBeInTheDocument();
  });

  it("says a dev session has no sign-in to protect", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/development session — there is no sign-in/i)).toBeInTheDocument();
    // No Set up button, because there is nothing a header-based session could
    // enrol and nowhere to send anybody.
    expect(screen.queryByRole("link", { name: /set up/i })).not.toBeInTheDocument();
  });

  it("reports it as on when the credential said so", () => {
    overview = anOverview({
      signIn: { mode: "clerk", managedExternally: true, secondFactor: true },
    });
    render(<PrivacyPage />);

    expect(screen.getByText("Two-factor authentication is turned on")).toBeInTheDocument();
  });

  it("reports it as off when the credential said so", () => {
    overview = anOverview({
      signIn: { mode: "clerk", managedExternally: true, secondFactor: false },
    });
    render(<PrivacyPage />);

    expect(screen.getByText("Two-factor authentication is turned off")).toBeInTheDocument();
  });

  it("does not call silence 'off'", () => {
    overview = anOverview({
      signIn: { mode: "clerk", managedExternally: true, secondFactor: null },
    });
    render(<PrivacyPage />);

    // Clerk's default token carries no such claim. Guessing "off" here would be
    // wrong in the one direction somebody acts on.
    expect(screen.getByText("Your sign-in provider hasn't said")).toBeInTheDocument();
    expect(screen.queryByText(/turned off/i)).not.toBeInTheDocument();
  });

  it("says where to look when no account page is configured", () => {
    overview = anOverview({
      signIn: { mode: "clerk", managedExternally: true, secondFactor: false },
    });
    render(<PrivacyPage />);

    // A Set up button pointing at a URL the UI invented is a security control
    // that leads nowhere, so the env var's absence is stated instead.
    expect(screen.getByText(/No account page has been\s+configured/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /set up/i })).not.toBeInTheDocument();
  });

  it("offers no enrolment of its own, in any state", () => {
    overview = anOverview({
      signIn: { mode: "clerk", managedExternally: true, secondFactor: false },
    });
    render(<PrivacyPage />);

    // The failure this whole card is written to avoid: a TOTP flow here would
    // produce a factor that sign-in never checks.
    expect(screen.queryByText(/scan (the|this) QR/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up|enable two|verify code/i })).not.toBeInTheDocument();
  });
});
