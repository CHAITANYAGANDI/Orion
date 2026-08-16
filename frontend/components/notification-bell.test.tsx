import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppNotification } from "@/lib/types";

/**
 * The bell.
 *
 * <p>A notification list fails in one direction: it says too much, somebody
 * stops looking, and then the upload that failed overnight sits unread among
 * forty that did not matter. So most of these tests are about the list keeping
 * its signal — the unread state has to survive a glance, dismissing something
 * must not navigate to it, and a failure has to be distinguishable from a
 * success without reading the sentence.
 *
 * <p>The other group is about the socket being an optimisation rather than a
 * dependency. Its frames carry a count and no content, so what a ping does is
 * trigger an authenticated re-read; a bell that rendered what arrived on a
 * public topic would be rendering whatever anybody put there.
 */
const {
  markRead,
  markAllRead,
  remove,
  clearAll,
  subscribeNotifications,
  socket,
} = vi.hoisted(() => ({
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  remove: vi.fn(),
  clearAll: vi.fn(),
  subscribeNotifications: vi.fn(),
  socket: { onPing: null as ((unread: number) => void) | null },
}));

let items: AppNotification[];
let unread: number;
let total: number | null;
let refetchedCount: number;

vi.mock("@/lib/ws", () => ({
  subscribeNotifications: (channel: string, onPing: (n: number) => void) => {
    subscribeNotifications(channel);
    socket.onPing = onPing;
    return { deactivate: vi.fn() };
  },
}));

vi.mock("@/lib/api", () => ({
  useGetUnreadCountQuery: () => ({
    data: { unread, channel: "usr_1" },
    refetch: () => {
      refetchedCount += 1;
    },
  }),
  // Honours `unread`, because the tab is a second query rather than a filter
  // over rows already fetched — see the panel's comment.
  useGetNotificationsQuery: (
    arg: { size?: number; unread?: boolean } | undefined,
    opts: { skip?: boolean },
  ) => {
    if (opts?.skip) return { data: undefined, isLoading: false, refetch: vi.fn() };
    const shown = arg?.unread ? items.filter((n) => !n.read) : items;
    return {
      data: { content: shown, page: 0, size: 20, totalElements: total ?? shown.length, totalPages: 1 },
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useMarkNotificationReadMutation: () => [
    (arg: unknown) => {
      markRead(arg);
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useMarkAllNotificationsReadMutation: () => [
    () => {
      markAllRead();
      return { unwrap: () => Promise.resolve({}) };
    },
    { isLoading: false },
  ],
  useDeleteNotificationMutation: () => [
    (id: string) => {
      remove(id);
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
  useClearNotificationsMutation: () => [
    () => {
      clearAll();
      return { unwrap: () => Promise.resolve() };
    },
    { isLoading: false },
  ],
}));

import { NotificationBell, ago } from "@/components/notification-bell";

function notification(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "ntf_1",
    kind: "SUMMARY_READY",
    kindLabel: "Summary ready",
    title: "Sprint planning",
    body: "The notes are written.",
    meetingId: "mtg_1",
    actionItemId: null,
    link: "/meetings/mtg_1",
    read: false,
    readAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

async function openBell() {
  render(<NotificationBell />);
  await userEvent.click(screen.getByRole("button", { name: /Notifications/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  items = [notification()];
  unread = 1;
  total = null;
  refetchedCount = 0;
  socket.onPing = null;
});

describe("NotificationBell badge", () => {
  it("counts what has not been seen", () => {
    unread = 3;
    render(<NotificationBell />);

    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });

  it("stops counting past a point and starts gesturing", () => {
    unread = 42;
    render(<NotificationBell />);

    // "42" in a 16px circle is unreadable, and the difference between 42 and 43
    // changes nobody's behaviour.
    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("shows no badge when there is nothing new", () => {
    unread = 0;
    render(<NotificationBell />);

    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});

describe("NotificationBell list", () => {
  it("does not fetch the list until it is opened", () => {
    render(<NotificationBell />);

    // Every open tab polling a list nobody has looked at is what makes a bell
    // expensive for no one's benefit.
    expect(screen.queryByText("Sprint planning")).not.toBeInTheDocument();
  });

  it("shows what happened and when", async () => {
    await openBell();

    expect(screen.getByText("Sprint planning")).toBeInTheDocument();
    expect(screen.getByText("The notes are written.")).toBeInTheDocument();
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("says what the bell is for when there is nothing in it", async () => {
    items = [];
    await openBell();

    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });

  it("does not mark everything read just because it was opened", async () => {
    await openBell();

    // The shortcut that destroys the only signal the list carries: glancing at
    // the bell would bury the overdue task among things already dealt with.
    expect(markAllRead).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks one read when it is opened", async () => {
    await openBell();

    await userEvent.click(screen.getByRole("link", { name: /Sprint planning/ }));

    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ id: "ntf_1", read: true }));
  });

  it("does not re-mark something already read", async () => {
    items = [notification({ read: true })];
    await openBell();

    await userEvent.click(screen.getByRole("link", { name: /Sprint planning/ }));

    expect(markRead).not.toHaveBeenCalled();
  });

  it("puts one back to unread", async () => {
    items = [notification({ read: true })];
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /Mark .* unread/ }));

    // How somebody keeps a reminder about work they cannot start yet.
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ id: "ntf_1", read: false }));
  });

  it("dismisses one without following it", async () => {
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));

    // The dismiss control sits outside the link's hit area on purpose.
    expect(remove).toHaveBeenCalledWith("ntf_1");
    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks the lot read in one go", async () => {
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /Mark all as read/ }));

    expect(markAllRead).toHaveBeenCalled();
  });

  it("greys out marking-all rather than hiding it when everything is read", async () => {
    unread = 0;
    items = [notification({ read: true })];
    await openBell();

    // A control that vanishes teaches nobody it exists. Greyed out, it says both
    // what it does and that there is currently nothing to do.
    expect(screen.getByRole("button", { name: /Mark all as read/ })).toBeDisabled();
  });

  it("clears the list", async () => {
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /Clear/ }));

    expect(clearAll).toHaveBeenCalled();
  });

  it("dates the list rather than leaving a wall of rows", async () => {
    items = [
      notification({ id: "n1", createdAt: new Date().toISOString() }),
      notification({ id: "n2", createdAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ];
    await openBell();

    expect(screen.getByRole("heading", { name: /^Today, / })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Yesterday, / })).toBeInTheDocument();
  });

  it("offers a plain row for something with nowhere to go", async () => {
    items = [notification({ kind: "RECORDING_STARTED", link: null, title: "Recording started" })];
    await openBell();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Recording started")).toBeInTheDocument();
  });
});

describe("NotificationBell Inbox and Unread", () => {
  it("opens on Inbox", async () => {
    await openBell();

    expect(screen.getByRole("button", { name: "Inbox" })).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows to what has not been read", async () => {
    items = [notification({ id: "n1", title: "Read one", read: true }), notification({ id: "n2", title: "New one" })];
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /^Unread/ }));

    expect(screen.getByText("New one")).toBeInTheDocument();
    expect(screen.queryByText("Read one")).not.toBeInTheDocument();
  });

  it("carries the count on the tab, so the number survives opening the panel", async () => {
    unread = 3;
    await openBell();

    expect(screen.getByRole("button", { name: "Unread 3" })).toBeInTheDocument();
  });

  it("says so rather than looking broken when nothing is unread", async () => {
    unread = 0;
    items = [notification({ read: true })];
    await openBell();

    await userEvent.click(screen.getByRole("button", { name: /^Unread/ }));

    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
  });

  it("goes back to Inbox once the panel is closed", async () => {
    render(<NotificationBell />);
    const bell = screen.getByRole("button", { name: /Notifications/ });

    await userEvent.click(bell);
    await userEvent.click(screen.getByRole("button", { name: /^Unread/ }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(bell);

    // Otherwise the morning after marking everything read, the bell opens onto
    // an empty pane and reads as one that has stopped working.
    expect(screen.getByRole("button", { name: "Inbox" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("NotificationBell end of the list", () => {
  it("says the list is complete when it is", async () => {
    await openBell();

    expect(screen.getByText("That's all your notifications.")).toBeInTheDocument();
  });

  it("says how much is shown when there is more", async () => {
    // Recallix keeps notifications until they are cleared, so the panel says
    // what it is showing rather than claiming a retention window it has not got.
    total = 64;
    await openBell();

    expect(screen.getByText("Showing the 1 most recent of 64.")).toBeInTheDocument();
  });
});

describe("NotificationBell live updates", () => {
  it("listens on the channel the server named", () => {
    render(<NotificationBell />);

    // The browser is authenticated as a Clerk subject and has never been told
    // its internal user id, so the channel is served rather than derived.
    expect(subscribeNotifications).toHaveBeenCalledWith("usr_1");
  });

  it("re-reads over the API rather than trusting the frame", async () => {
    render(<NotificationBell />);

    socket.onPing?.(7);

    // The topic is public. Rendering what arrives on it would be rendering
    // whatever anybody chose to put there.
    await waitFor(() => expect(refetchedCount).toBeGreaterThan(0));
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });
});

describe("ago", () => {
  const now = new Date("2026-08-16T12:00:00Z").getTime();

  it("reads as a glance rather than a timestamp", () => {
    expect(ago("2026-08-16T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-08-16T11:20:00Z", now)).toBe("40m ago");
    expect(ago("2026-08-16T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-08-14T12:00:00Z", now)).toBe("2d ago");
  });

  it("falls back to a date once relative stops meaning anything", () => {
    // "23d ago" is not a thing anybody converts into a day of the week.
    expect(ago("2026-07-24T12:00:00Z", now)).toContain("2026");
  });

  it("says nothing rather than NaN for a date it cannot read", () => {
    expect(ago("not a date", now)).toBe("");
  });
});
