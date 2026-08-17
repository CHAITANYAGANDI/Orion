import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse } from "@/lib/types";

/**
 * Account Settings → Meetings.
 *
 * Sharing and Chat are both defaults, and the tests that matter are the ones
 * that keep them defaults. A new share link starts from these; a link already
 * sent is never rewritten, because that would revoke access nobody asked to
 * revoke. The chat window bounds a whole-workspace question and not a narrowed
 * one, because naming meetings is somebody choosing them.
 *
 * Feedback and Training is tested for the absence of a control. Recallix trains
 * nothing, so a toggle here would imply a use to opt out of — and "off by
 * default" is exactly what somebody would add later without noticing that it
 * makes the section a lie in the other direction.
 */
const { update, toastError } = vi.hoisted(() => ({
  update: vi.fn(),
  toastError: vi.fn(),
}));

let prefs: PreferencesResponse;

vi.mock("@/lib/api", () => ({
  useGetPreferencesQuery: () => ({ data: prefs, isLoading: false }),
  useUpdatePreferencesMutation: () => [
    (body: unknown) => {
      update(body);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/components/vocabulary-card", () => ({
  VocabularyCard: () => <div data-testid="vocabulary-card" />,
}));
vi.mock("@/components/known-speakers-card", () => ({
  KnownSpeakersCard: () => <div data-testid="known-speakers-card" />,
}));

import { MeetingsTab } from "@/components/settings/meetings-tab";

beforeEach(() => {
  vi.clearAllMocks();
  prefs = {
    email: "priya@example.com",
    autoEmailRecap: false,
    recapEmail: null,
    effectiveRecapEmail: "priya@example.com",
    displayName: "Priya Raman",
    department: null,
    jobRole: null,
    defaultLanguage: null,
    shareIncludeSummary: true,
    shareIncludeActionItems: true,
    shareIncludeTranscript: false,
    shareIncludeAudio: false,
    shareExpiryDays: null,
    chatHistoryDays: null,
    taskReminders: false,
    digestWeekly: false,
    emailsEnabled: true,
    recapForImports: false,
    shareOpenedEmail: false,
    mutedNotifications: [],
  };
});

describe("sharing defaults", () => {
  it("starts with notes shared and the recording not", () => {
    render(<MeetingsTab />);

    // A transcript is every word somebody said and a recording is their voice.
    expect(screen.getByRole("checkbox", { name: "Summary" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Action items" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Full transcript" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Recording" })).not.toBeChecked();
  });

  it("saves one flag at a time", async () => {
    render(<MeetingsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Full transcript" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ shareIncludeTranscript: true }));
  });

  it("opens on never expiring, which is what every existing link does", () => {
    render(<MeetingsTab />);

    expect(screen.getByLabelText("When a new link expires")).toHaveValue("");
  });

  it("sets an expiry in days", async () => {
    render(<MeetingsTab />);

    await userEvent.selectOptions(screen.getByLabelText("When a new link expires"), "30");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ shareExpiryDays: 30 }));
  });

  it("sends a flag rather than a null to go back to never", async () => {
    prefs = { ...prefs, shareExpiryDays: 30 };
    render(<MeetingsTab />);

    await userEvent.selectOptions(screen.getByLabelText("When a new link expires"), "");

    // An absent number cannot say the difference between "never" and "leave it".
    await waitFor(() => expect(update).toHaveBeenCalledWith({ shareNeverExpires: true }));
  });

  it("says the change does not reach in and rewrite links already sent", () => {
    render(<MeetingsTab />);

    expect(screen.getByText(/never rewrites a link you have already sent/)).toBeInTheDocument();
  });
});

describe("chat access", () => {
  it("opens on every meeting", () => {
    render(<MeetingsTab />);

    expect(screen.getByLabelText("Meeting access")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Every meeting" })).toBeInTheDocument();
  });

  it("narrows the window", async () => {
    render(<MeetingsTab />);

    await userEvent.selectOptions(screen.getByLabelText("Meeting access"), "90");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ chatHistoryDays: 90 }));
  });

  it("widens it back with its own flag", async () => {
    prefs = { ...prefs, chatHistoryDays: 90 };
    render(<MeetingsTab />);

    await userEvent.selectOptions(screen.getByLabelText("Meeting access"), "");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ chatReadsEverything: true }));
  });

  it("says plainly that narrowing hides nothing", () => {
    render(<MeetingsTab />);

    // It is a scope control, not a privacy boundary, and somebody reading it as
    // the latter would think their old meetings were protected.
    expect(screen.getByText(/Nothing is hidden or deleted/)).toBeInTheDocument();
    expect(screen.getByText(/Open action items are always included/)).toBeInTheDocument();
  });
});

describe("feedback and training", () => {
  it("says Recallix does not train on your meetings", () => {
    render(<MeetingsTab />);

    expect(screen.getByText(/does not train on your meetings/)).toBeInTheDocument();
  });

  it("offers no switch, because there is nothing to switch off", () => {
    render(<MeetingsTab />);

    const section = screen.getByRole("region", { name: "Feedback and Training" });
    expect(section.querySelectorAll("input, select, button")).toHaveLength(0);
  });

  it("points at where the data can be seen and deleted", () => {
    render(<MeetingsTab />);

    expect(screen.getByRole("link", { name: /what Recallix holds of yours/i })).toHaveAttribute(
      "href",
      "/settings/security",
    );
  });
});

describe("what was already here", () => {
  it("keeps vocabulary and known speakers", () => {
    render(<MeetingsTab />);

    // General links here for vocabulary, so it cannot quietly move away.
    expect(screen.getByTestId("vocabulary-card")).toBeInTheDocument();
    expect(screen.getByTestId("known-speakers-card")).toBeInTheDocument();
  });
});
