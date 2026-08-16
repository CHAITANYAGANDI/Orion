import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SharedMeeting } from "@/lib/types";

/**
 * The page a recipient sees.
 *
 * <p>This is the only unauthenticated screen in the app, so the tests are about
 * what it does with what it is given — and about what it never says. A page that
 * announces "the transcript was hidden from you" tells a stranger there is
 * something worth asking for; one that renders only what arrived tells them
 * nothing they did not already have.
 */
vi.mock("next/navigation", () => ({ useParams: () => ({ token: "tok" }) }));

const fetchMock = vi.fn();

import SharedMeetingPage from "@/app/shared/[token]/page";

function meeting(over: Partial<SharedMeeting> = {}): SharedMeeting {
  return {
    title: "Sprint planning",
    meetingDate: "2026-08-15T14:00:00Z",
    durationSeconds: 3600,
    shortSummary: "We agreed to move billing to Stripe.",
    detailedSummary: "We agreed to move billing to Stripe.",
    keyPoints: ["Stripe by Q4"],
    actionItems: [{ title: "Draft the plan", ownerName: "Marcus", dueDate: null, priority: "high" }],
    transcript: null,
    ...over,
  };
}

function respond(status: number, body?: unknown) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  respond(200, meeting());
});

describe("SharedMeetingPage", () => {
  it("shows what was shared", async () => {
    render(<SharedMeetingPage />);

    expect(await screen.findByText("Sprint planning")).toBeInTheDocument();
    expect(screen.getByText(/move billing to Stripe/)).toBeInTheDocument();
    expect(screen.getByText("Draft the plan")).toBeInTheDocument();
  });

  it("says nothing about what was withheld", async () => {
    respond(200, meeting({ shortSummary: null, detailedSummary: null, keyPoints: [], transcript: null }));
    render(<SharedMeetingPage />);

    await screen.findByText("Sprint planning");
    // Absent is absent. Naming it would advertise what to ask for.
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
    expect(screen.queryByText(/hidden|withheld|not shared/i)).not.toBeInTheDocument();
  });

  it("plays the recording only when one was shared", async () => {
    const { container, unmount } = render(<SharedMeetingPage />);
    await screen.findByText("Sprint planning");
    expect(container.querySelector("audio")).toBeNull();

    unmount();
    respond(200, meeting({ audioUrl: "https://storage/signed.mp3" }));
    const withAudio = render(<SharedMeetingPage />);
    await screen.findByText("Sprint planning");
    expect(withAudio.container.querySelector("audio")).toHaveAttribute(
      "src",
      "https://storage/signed.mp3",
    );
  });

  it("treats every kind of dead link the same", async () => {
    respond(404);
    render(<SharedMeetingPage />);

    // Revoked, expired and never-existed are deliberately one message.
    expect(await screen.findByText("This link is no longer available")).toBeInTheDocument();
  });
});

describe("SharedMeetingPage password", () => {
  it("asks for the password rather than failing", async () => {
    respond(401);
    render(<SharedMeetingPage />);

    expect(await screen.findByText("This link is password protected")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("sends the password in a header, never in the URL", async () => {
    respond(401);
    render(<SharedMeetingPage />);
    await screen.findByLabelText("Password");

    respond(200, meeting());
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(screen.getByText("Sprint planning")).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    // A URL is written to server logs, browser history and every proxy between.
    expect(url).not.toContain("hunter2");
    expect((init.headers as Record<string, string>)["X-Share-Password"]).toBe("hunter2");
  });

  it("says when the password is wrong, and stays open", async () => {
    respond(401);
    render(<SharedMeetingPage />);
    await screen.findByLabelText("Password");

    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("That password is not right.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});

describe("SharedMeetingPage moments", () => {
  const excerpt = meeting({
    startSeconds: 942,
    endSeconds: 968,
    durationSeconds: null,
    transcript: "Priya: We should move billing to Stripe.",
    audioUrl: "https://storage/signed.mp3",
  });

  it("says it is an excerpt and where it came from", async () => {
    respond(200, excerpt);
    render(<SharedMeetingPage />);

    expect(await screen.findByText(/excerpt from 15:42/)).toBeInTheDocument();
    expect(screen.getByText("Shared moment")).toBeInTheDocument();
  });

  it("names the bounds of the recording it plays", async () => {
    respond(200, excerpt);
    render(<SharedMeetingPage />);

    // The file behind a moment link is still the whole meeting, so the page
    // has to say which part of it this is.
    expect(await screen.findByText("15:42 – 16:08 of the recording")).toBeInTheDocument();
  });

  it("calls the clipped text what it is", async () => {
    respond(200, excerpt);
    render(<SharedMeetingPage />);

    expect(await screen.findByText("What was said")).toBeInTheDocument();
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
  });
});
