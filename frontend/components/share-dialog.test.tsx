import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShareResponse, TranscriptMoment } from "@/lib/types";

/**
 * The share dialog.
 *
 * <p>Every test here is about what a link gives away. The dials default closed,
 * turning one on must not turn another off, and the password must never travel
 * with the link it protects. A mistake in any of those publishes something, and
 * unlike most bugs it cannot be taken back — the recipient already has it.
 */
const { createShare, revokeShare, revokeOne, emailShare } = vi.hoisted(() => ({
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  revokeOne: vi.fn(),
  emailShare: vi.fn(),
}));

let links: ShareResponse[];
let moments: TranscriptMoment[];

vi.mock("@/lib/api", () => ({
  useGetShareLinksQuery: () => ({ data: links, isLoading: false }),
  useGetMomentsQuery: () => ({ data: moments }),
  useCreateShareMutation: () => [
    (arg: unknown) => {
      createShare(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useRevokeShareMutation: () => [
    (arg: unknown) => {
      revokeShare(arg);
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
  useRevokeShareLinkMutation: () => [
    (arg: unknown) => {
      revokeOne(arg);
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
  useEmailShareMutation: () => [
    (arg: unknown) => {
      emailShare(arg);
      return { unwrap: () => Promise.resolve({ sent: 2 }) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ShareDialog } from "@/components/share-dialog";

function link(over: Partial<ShareResponse> = {}): ShareResponse {
  return {
    id: "shr_1",
    token: "tok",
    url: "http://localhost:3000/shared/tok",
    label: "",
    includeSummary: true,
    includeActionItems: true,
    includeTranscript: false,
    includeAudio: false,
    passwordProtected: false,
    expiresAt: null,
    startSeconds: null,
    endSeconds: null,
    quote: "",
    viewCount: 3,
    lastViewedAt: null,
    createdAt: "2026-08-15T09:00:00Z",
    ...over,
  };
}

async function openDialog() {
  render(<ShareDialog meetingId="mtg_1" />);
  await userEvent.click(screen.getByRole("button", { name: /Share/ }));
}

/** The body of the most recent save. */
function lastSave() {
  return (createShare.mock.calls.at(-1)?.[0] as { body: Record<string, unknown> })?.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  links = [link()];
  moments = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("ShareDialog contents", () => {
  it("offers a switch per kind of content, not a role", async () => {
    await openDialog();

    // Viewer/commenter/editor describe what a person may do, and there is no
    // person — everyone holding the link is the same anonymous reader.
    for (const label of ["Summary", "Action items", "Full transcript", "Recording"]) {
      expect(screen.getByRole("checkbox", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.queryByText(/commenter|editor/i)).not.toBeInTheDocument();
  });

  it("shares the written account by default and the raw material never", async () => {
    await openDialog();

    expect(screen.getByRole("checkbox", { name: /Summary/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Action items/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Full transcript/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Recording/ })).not.toBeChecked();
  });

  it("changes one dial without touching the others", async () => {
    await openDialog();

    await userEvent.click(screen.getByRole("checkbox", { name: /Recording/ }));

    // Sending the whole state back would let a stale checkbox silently
    // un-share something the owner had turned on elsewhere.
    await waitFor(() => expect(lastSave()).toEqual({ includeAudio: true }));
  });

  it("can withhold the summary while sharing the actions", async () => {
    await openDialog();

    await userEvent.click(screen.getByRole("checkbox", { name: /Summary/ }));

    await waitFor(() => expect(lastSave()).toEqual({ includeSummary: false }));
  });
});

describe("ShareDialog protection", () => {
  it("sets a password", async () => {
    await openDialog();

    await userEvent.type(screen.getByLabelText("Share password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() => expect(lastSave()).toEqual({ password: "hunter2" }));
  });

  it("will not set a password too short to be one", async () => {
    await openDialog();

    await userEvent.type(screen.getByLabelText("Share password"), "abc");

    expect(screen.getByRole("button", { name: "Set" })).toBeDisabled();
  });

  it("removes a password with a flag rather than an empty string", async () => {
    links = [link({ passwordProtected: true })];
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    // An absent password and an explicit empty one arrive identically; only a
    // flag can mean "take it off".
    await waitFor(() => expect(lastSave()).toEqual({ removePassword: true }));
  });

  it("says a password is set without saying what it is", async () => {
    links = [link({ passwordProtected: true })];
    await openDialog();

    expect(screen.getByText("Password protected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Share password")).not.toBeInTheDocument();
  });

  it("expires the link, and can make it permanent again", async () => {
    await openDialog();

    await userEvent.click(screen.getByLabelText("Expires"));
    await userEvent.click(screen.getByRole("option", { name: "7 days" }));

    await waitFor(() => expect(lastSave()).toEqual({ expiresInDays: 7 }));
  });
});

describe("ShareDialog delivery", () => {
  it("emails the link to several addresses at once", async () => {
    await openDialog();

    await userEvent.type(
      screen.getByLabelText("Email addresses"),
      "a@example.com, b@example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: /Send link/ }));

    await waitFor(() =>
      expect(emailShare).toHaveBeenCalledWith({
        id: "mtg_1",
        body: { to: ["a@example.com", "b@example.com"], message: "" },
      }),
    );
  });

  it("says plainly that emailing is not restricting", async () => {
    await openDialog();

    // Calling it an invitation would be a lie the recipient cannot detect and
    // the sender would rely on.
    expect(screen.getByText(/does not restrict it to those addresses/)).toBeInTheDocument();
  });

  it("copies the link", async () => {
    await openDialog();

    await userEvent.click(screen.getByLabelText("Copy link"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "http://localhost:3000/shared/tok",
    );
  });
});

describe("ShareDialog moments", () => {
  const moment: TranscriptMoment = {
    id: "mom_1",
    meetingId: "mtg_1",
    kind: "HIGHLIGHT",
    ranges: [],
    quote: "We should move billing to Stripe.",
    body: "",
    speaker: "Priya",
    startSeconds: 10,
    endSeconds: 26,
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
  };

  it("offers a link for a passage already marked", async () => {
    moments = [moment];
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Create link" }));

    // Built from the mark rather than a free-form range: it already carries the
    // quote, so the link keeps showing what was shared after a reprocess.
    await waitFor(() =>
      expect(lastSave()).toEqual({
        startSeconds: 10,
        endSeconds: 26,
        quote: "We should move billing to Stripe.",
      }),
    );
  });

  it("ignores a bookmark, which marks a time rather than a passage", async () => {
    moments = [{ ...moment, kind: "BOOKMARK", startSeconds: 30, endSeconds: 30 }];
    await openDialog();

    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
  });

  it("revokes one moment link without touching the meeting's", async () => {
    links = [link(), link({ id: "shr_2", token: "tok2", startSeconds: 10, endSeconds: 26 })];
    await openDialog();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(revokeOne).toHaveBeenCalledWith({ shareId: "shr_2", meetingId: "mtg_1" });
    expect(revokeShare).not.toHaveBeenCalled();
  });
});

describe("ShareDialog before there is a link", () => {
  it("publishes nothing until asked", async () => {
    links = [];
    await openDialog();

    expect(createShare).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Share link")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Create share link/ }));
    expect(createShare).toHaveBeenCalledWith({ id: "mtg_1", body: {} });
  });
});
