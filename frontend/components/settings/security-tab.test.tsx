import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PrivacyOverview } from "@/lib/types";

/**
 * The Security tab — what is left of it.
 *
 * <p>It used to carry the whole privacy overview: the counts, the bucket
 * configuration, the live share links, the retention dials, the archive and the
 * close-account control. Those were removed on request, and their tests went
 * with them rather than being left asserting against markup that no longer
 * renders.
 *
 * <p>What remains is the one card that was never about data at all, and the
 * tests that matter are still about a sentence being true rather than a control
 * working: this card reports a second factor it does not own and cannot set, so
 * the failure to guard against is it stating something the credential never
 * said.
 */
let overview: PrivacyOverview;

vi.mock("@/lib/api", () => ({
  useGetPrivacyOverviewQuery: () => ({ data: overview, isLoading: false }),
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
  overview = anOverview();
});

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
