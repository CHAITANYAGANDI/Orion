import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse } from "@/lib/types";

/**
 * Account Settings → Emails.
 *
 * This is the only page in Recallix that decides whether somebody is contacted
 * without opening the app, so the tests are weighted the same way the risk is:
 * every switch starts off, the master silences without forgetting, and no switch
 * covers for another.
 *
 * The group that matters most after V43 is the per-row one. Eight rows write
 * eight boolean fields whose names differ by a word, and the failure they share
 * is positional: turning on "Highlights" saving `commentEmail` instead. Nothing
 * on screen would show it — both switches render, both persist, and only the
 * wrong mail arriving a day later gives it away. So each row is asserted
 * against the field it is supposed to write, one at a time.
 *
 * The last group asserts what the page no longer has. The recap address field
 * and the bell's switches were removed on request, and both backed capabilities
 * that still exist server-side with no caller — so the absence is a decision,
 * and a test is the only place a decision like that survives.
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
    weeklyDigest: false,
    emailsEnabled: true,
    recapForImports: false,
    shareOpenedEmail: false,
    commentEmail: false,
    highlightEmail: false,
    mutedNotifications: [],
  };
});

/** Every row, in the order the page lists it, and the field it writes. */
const ROWS: [string, keyof PreferencesResponse][] = [
  ["Meeting summary", "autoEmailRecap"],
  ["Imported conversation", "recapForImports"],
  ["Conversation shared", "shareOpenedEmail"],
  ["Weekly digest", "weeklyDigest"],
  ["Event reminder", "taskReminders"],
  ["Comments", "commentEmail"],
  ["Highlights", "highlightEmail"],
];

describe("EmailsTab switches", () => {
  it("offers every message it can actually send", () => {
    render(<EmailsTab />);

    for (const [name] of ROWS) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
    }
  });

  it.each(ROWS)("%s writes its own field and no other", async (name, field) => {
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name }));

    // Exact equality, not objectContaining: a patch that sets the right field
    // and a neighbour would pass the looser assertion and send mail nobody
    // asked for. `emailsEnabled` rides along on every switch-on, so a ticked
    // row is never blocked by a gate somebody closed earlier.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ [field]: true, emailsEnabled: true }),
    );
  });

  it("shows every switch off until it is turned on", () => {
    render(<EmailsTab />);

    for (const [name] of ROWS) {
      expect(screen.getByRole("checkbox", { name })).not.toBeChecked();
    }
  });

  it("reads each switch back from its own field", () => {
    // The mirror of the write test: a crossed wire on the read side shows the
    // wrong row switched on, which is how somebody turns off the mail they
    // wanted to keep.
    prefs = { ...prefs, commentEmail: true };
    render(<EmailsTab />);

    expect(screen.getByRole("checkbox", { name: "Comments" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Highlights" })).not.toBeChecked();
  });

  it("keeps the recap for recordings separate from the recap for imports", async () => {
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Imported conversation" }));

    // The whole point of the split: an archive of sixty files must not be able
    // to ride in on the switch somebody turned on for their four weekly calls.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ recapForImports: true, emailsEnabled: true }),
    );
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ autoEmailRecap: true }));
  });
});

/** Every row on, which is what the select-all writes. */
const ALL_ON = Object.fromEntries(ROWS.map(([, field]) => [field, true]));
const ALL_OFF = Object.fromEntries(ROWS.map(([, field]) => [field, false]));

describe("EmailsTab select-all", () => {
  const master = () => screen.getByRole("checkbox", { name: "All emails" });

  it("is unticked when nothing below it is on", () => {
    render(<EmailsTab />);

    // It reads the rows rather than its own field. A tickbox above a list of
    // seven unticked rows has to be unticked, whatever `emailsEnabled` says.
    expect(master()).not.toBeChecked();
    expect(master()).not.toBePartiallyChecked();
  });

  it("is ticked only when every row is on", () => {
    prefs = { ...prefs, ...ALL_ON };
    render(<EmailsTab />);

    expect(master()).toBeChecked();
  });

  it("is partially ticked when some are on", () => {
    prefs = { ...prefs, commentEmail: true };
    render(<EmailsTab />);

    // Neither ticked nor blank: blank would say nothing is on while a row
    // below it is visibly ticked.
    expect(master()).toBePartiallyChecked();
    expect(screen.getByText(/1 of 7 are on/i)).toBeInTheDocument();
  });

  it("turns every row on in one save", async () => {
    prefs = { ...prefs, commentEmail: true };
    render(<EmailsTab />);

    await userEvent.click(master());

    // One patch, not seven: seven would each pop a toast, and a failure
    // halfway would leave the page half on with nothing to explain it.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ ...ALL_ON, emailsEnabled: true }),
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("turns every row off in one save", async () => {
    prefs = { ...prefs, ...ALL_ON };
    render(<EmailsTab />);

    await userEvent.click(master());

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ ...ALL_OFF, emailsEnabled: false }),
    );
  });

  it("re-opens the gate when a single row is switched back on", async () => {
    // Otherwise unticking the master and picking one row back out would tick
    // the box and send nothing, because every sender checks the gate first.
    prefs = { ...prefs, emailsEnabled: false };
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Comments" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ commentEmail: true, emailsEnabled: true }),
    );
  });

  it("leaves the gate alone when a row is switched off", async () => {
    prefs = { ...prefs, ...ALL_ON };
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Comments" }));

    // Nothing to re-open, and closing the gate here would be a second meaning
    // for one click.
    await waitFor(() => expect(update).toHaveBeenCalledWith({ commentEmail: false }));
  });

  it("never disables a row", () => {
    prefs = { ...prefs, emailsEnabled: false };
    render(<EmailsTab />);

    // The rows used to grey out under a master that was off. They cannot now:
    // the master being unticked means they are off, not held.
    for (const [name] of ROWS) {
      expect(screen.getByRole("checkbox", { name })).toBeEnabled();
    }
  });
});

describe("EmailsTab digests", () => {
  it("has no cadence dropdown, because the cadence is now two rows", () => {
    prefs = { ...prefs, taskReminders: true, weeklyDigest: true };
    render(<EmailsTab />);

    // Until V43 these were one switch with "every morning" or "Mondays", which
    // made them exclusive — so wanting a morning prompt and a Monday review
    // meant choosing one.
    expect(screen.queryByRole("combobox", { name: "How often" })).not.toBeInTheDocument();
  });

  it("lets both be on at once", async () => {
    prefs = { ...prefs, weeklyDigest: true };
    render(<EmailsTab />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Event reminder" }));

    expect(screen.getByRole("checkbox", { name: "Weekly digest" })).toBeChecked();
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ taskReminders: true, emailsEnabled: true }),
    );
  });

  it("says a Monday sends one of them rather than both", () => {
    render(<EmailsTab />);

    // Two mails a minute apart from overlapping lists reads as a bug, so the
    // page has to say which one wins before somebody switches both on.
    expect(screen.getByText(/you get the digest above instead, not both/i)).toBeInTheDocument();
  });
});

describe("EmailsTab is switches and nothing else", () => {
  it("offers no way to change the address, and does not claim to", () => {
    render(<EmailsTab />);

    // Removed on request. The field is the only thing that ever wrote
    // `recapEmail`, so mail now goes to the account email or nowhere. Asserted
    // rather than left implicit, because putting the field back is a one-line
    // change and this test is what says the absence was deliberate.
    expect(screen.queryByLabelText(/Send all of it to/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("does not say where the mail goes", () => {
    render(<EmailsTab />);

    // The trade this makes: eight opt-in switches with no visible destination
    // fail silently on an account with no address on file.
    expect(screen.queryByText(/goes to priya@example.com/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nowhere to go/i)).not.toBeInTheDocument();
  });

  it("carries no bell switches", () => {
    render(<EmailsTab />);

    // `mutedNotifications` and GET /notifications/kinds both still work and now
    // have no caller, so every notification kind is on permanently.
    expect(screen.queryByText(/In-app notifications/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^Tell me/ })).not.toBeInTheDocument();
  });
});

describe("EmailsTab wording", () => {
  it("describes what Recallix does, not what a calendar would", () => {
    render(<EmailsTab />);

    // "Event reminder" is a borrowed row name. Recallix reads no calendar, so
    // the description has to say what will genuinely arrive or the switch is a
    // promise nothing can keep.
    expect(screen.getByText(/due today or in the next few days/i)).toBeInTheDocument();
  });

  it("says which direction sharing goes", () => {
    render(<EmailsTab />);

    // "Conversation shared" reads as inbound. It is not: nobody can share into
    // a one-account workspace, and the real event is somebody opening a link
    // that went out.
    expect(screen.getByText(/nobody can share into your account/i)).toBeInTheDocument();
  });

  it("warns that the noisy rows are capped before they are switched on", () => {
    render(<EmailsTab />);

    // Marking up a transcript is one activity, not fifteen events. Somebody
    // deciding whether to switch this on is deciding about volume.
    expect(screen.getAllByText(/at most one a day/i).length).toBeGreaterThan(0);
  });
});
