import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse } from "@/lib/types";

/**
 * Account Settings → Emails.
 *
 * This is the only page in Recallix that decides whether somebody is contacted
 * without opening the app, so the tests are weighted the same way the risk is:
 * every switch starts off, the master silences without forgetting, and the two
 * recap switches do not cover each other.
 *
 * The last group asserts what the page refuses to offer. Comments, highlights
 * and "shared with me" all need a second person, and a single-account product
 * that grew a switch for them would be promising mail that can never arrive —
 * an easy thing to add later by copying a competitor's settings page.
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
  useGetNotificationKindsQuery: () => ({
    data: [
      { kind: "SUMMARY_READY", label: "Summary ready", setting: "when the notes are written", mutable: true },
      { kind: "PROCESSING_FAILED", label: "Processing failed", setting: "when a meeting fails to process", mutable: false },
    ],
  }),
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { EmailsTab } from "@/components/settings/emails-tab";

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

describe("EmailsTab switches", () => {
  it("offers every message it can actually send", () => {
    render(<EmailsTab />);

    for (const name of [
      "Meeting summary",
      "Imported conversation",
      "Deadline digest",
      "Shared link opened",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
    }
  });

  it("saves one switch without touching the others", async () => {
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Shared link opened" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ shareOpenedEmail: true }));
  });

  it("keeps the recap for recordings separate from the recap for imports", async () => {
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Imported conversation" }));

    // The whole point of the split: an archive of sixty files must not be able
    // to ride in on the switch somebody turned on for their four weekly calls.
    await waitFor(() => expect(update).toHaveBeenCalledWith({ recapForImports: true }));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ autoEmailRecap: true }));
  });
});

describe("EmailsTab master switch", () => {
  it("is on by default, because everything under it is already opt-in", () => {
    render(<EmailsTab />);

    expect(screen.getByRole("checkbox", { name: "All emails" })).toBeChecked();
  });

  it("greys the rest out when it is off, rather than clearing them", () => {
    prefs = { ...prefs, emailsEnabled: false, autoEmailRecap: true, taskReminders: true };
    render(<EmailsTab />);

    const summary = screen.getByRole("checkbox", { name: "Meeting summary" });
    // Held, not lost — the switch still reads as on and comes back untouched.
    expect(summary).toBeChecked();
    expect(summary).toBeDisabled();
    expect(screen.getByText(/Your choices below are kept/i)).toBeInTheDocument();
  });

  it("sends only itself, so the switches underneath survive", async () => {
    prefs = { ...prefs, autoEmailRecap: true };
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "All emails" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ emailsEnabled: false }));
  });

  it("does not govern the bell", () => {
    prefs = { ...prefs, emailsEnabled: false };
    render(<EmailsTab />);

    // Silencing an inbox must not silence the failed upload waiting in the app.
    expect(screen.getByRole("checkbox", { name: /Tell me when the notes are written/ })).toBeEnabled();
  });
});

describe("EmailsTab digest cadence", () => {
  it("offers no cadence until the digest is on", () => {
    render(<EmailsTab />);

    expect(screen.queryByRole("combobox", { name: "How often" })).not.toBeInTheDocument();
  });

  it("offers daily or Mondays once it is", () => {
    prefs = { ...prefs, taskReminders: true };
    render(<EmailsTab />);

    expect(screen.getByRole("combobox", { name: "How often" })).toHaveValue("daily");
  });

  it("switches to weekly", async () => {
    prefs = { ...prefs, taskReminders: true };
    render(<EmailsTab />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "How often" }), "weekly");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ digestWeekly: true }));
  });
});

describe("EmailsTab destination", () => {
  it("says where all of it would go", () => {
    render(<EmailsTab />);

    expect(screen.getByText(/goes to priya@example.com/i)).toBeInTheDocument();
  });

  it("says plainly when there is nowhere to send it", () => {
    prefs = { ...prefs, effectiveRecapEmail: null as unknown as string };
    render(<EmailsTab />);

    // A dev session has no provider address, so every switch on this page is a
    // switch with no destination — worth saying rather than failing silently.
    expect(screen.getByText(/nowhere to go/i)).toBeInTheDocument();
  });
});

describe("EmailsTab what it will never send", () => {
  it("names the rows a reader arrives looking for", () => {
    render(<EmailsTab />);

    expect(screen.getByText(/Anything about a live or scheduled meeting/i)).toBeInTheDocument();
    expect(screen.getByText("Comments and highlights")).toBeInTheDocument();
    expect(screen.getByText(/A conversation shared with you/i)).toBeInTheDocument();
  });

  it("offers no switch for a message that could never arrive", () => {
    render(<EmailsTab />);

    // Copying a competitor's settings page is how these get added, and each one
    // would be a promise nothing in the product can keep.
    for (const name of [/^Comments$/, /^Highlights$/, /^Event reminder$/, /^Live meeting$/]) {
      expect(screen.queryByRole("checkbox", { name })).not.toBeInTheDocument();
    }
  });
});
