import { describe, it, expect } from "vitest";
import {
  BUCKET_ORDER,
  bucketFor,
  groupConversations,
  relativeTime,
} from "@/lib/conversations";
import type { ChatConversation } from "@/lib/types";

/**
 * Grouping chat threads for the history picker.
 *
 * The boundaries are calendar days rather than elapsed hours, and that is the
 * whole point: something said at 11pm last night is not "today" at 9am, even
 * though it is ten hours ago — and someone looking for it will look under
 * Yesterday. An elapsed-time implementation passes every casual test and then
 * puts last night's conversation in the wrong place every single morning.
 */

// A fixed "now" so the tests do not drift with the clock they run on.
const NOW = new Date("2026-08-14T14:00:00");

function at(iso: string, over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "cnv_1",
    meetingId: null,
    title: "A conversation",
    messageCount: 2,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

describe("bucketFor", () => {
  it("puts this morning under Today", () => {
    expect(bucketFor("2026-08-14T09:30:00", NOW)).toBe("Today");
  });

  it("puts one minute past midnight under Today", () => {
    expect(bucketFor("2026-08-14T00:01:00", NOW)).toBe("Today");
  });

  it("puts last night under Yesterday, not Today", () => {
    // Ten hours ago, and the case an elapsed-time implementation gets wrong.
    expect(bucketFor("2026-08-13T23:00:00", NOW)).toBe("Yesterday");
  });

  it("puts four days ago under Past week", () => {
    expect(bucketFor("2026-08-10T12:00:00", NOW)).toBe("Past week");
  });

  it("puts three weeks ago under Past month", () => {
    expect(bucketFor("2026-07-25T12:00:00", NOW)).toBe("Past month");
  });

  it("puts last year under Older", () => {
    expect(bucketFor("2025-08-14T12:00:00", NOW)).toBe("Older");
  });

  it("treats a slightly future timestamp as Today", () => {
    // A clock a few seconds ahead of the server would otherwise land in no
    // bucket at all and vanish from the picker.
    expect(bucketFor("2026-08-14T14:00:30", NOW)).toBe("Today");
  });

  it("sorts an unparseable timestamp to Older rather than throwing", () => {
    expect(bucketFor("not a date", NOW)).toBe("Older");
    expect(bucketFor("", NOW)).toBe("Older");
  });
});

describe("groupConversations", () => {
  it("drops empty groups", () => {
    const groups = groupConversations([at("2026-08-14T09:00:00")], NOW);
    // A picker showing five headings and one row reads as four failed loads.
    expect(groups.map((g) => g.name)).toEqual(["Today"]);
  });

  it("orders groups newest first", () => {
    const groups = groupConversations(
      [
        at("2025-01-01T09:00:00", { id: "old" }),
        at("2026-08-14T09:00:00", { id: "today" }),
        at("2026-08-10T09:00:00", { id: "week" }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.name)).toEqual(["Today", "Past week", "Older"]);
  });

  it("keeps the incoming order inside a group", () => {
    // The API already returns newest-first; re-sorting here would be a second
    // opinion that can disagree with it.
    const groups = groupConversations(
      [
        at("2026-08-14T11:00:00", { id: "later" }),
        at("2026-08-14T09:00:00", { id: "earlier" }),
      ],
      NOW,
    );
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["later", "earlier"]);
  });

  it("handles an empty list", () => {
    expect(groupConversations([], NOW)).toEqual([]);
  });

  it("only ever uses known bucket names", () => {
    const groups = groupConversations(
      ["2026-08-14T09:00", "2026-08-13T09:00", "2026-08-09T09:00", "2026-07-20T09:00", "2020-01-01T09:00"]
        .map((iso, i) => at(iso, { id: `c${i}` })),
      NOW,
    );
    for (const g of groups) {
      expect(BUCKET_ORDER).toContain(g.name);
    }
    expect(groups).toHaveLength(5);
  });
});

describe("relativeTime", () => {
  it("reads coarsely, because the heading already says roughly when", () => {
    expect(relativeTime("2026-08-14T13:59:30", NOW)).toBe("just now");
    expect(relativeTime("2026-08-14T13:58:00", NOW)).toBe("2m ago");
    expect(relativeTime("2026-08-14T11:00:00", NOW)).toBe("3h ago");
    expect(relativeTime("2026-08-10T14:00:00", NOW)).toBe("4d ago");
    expect(relativeTime("2026-06-14T14:00:00", NOW)).toBe("2mo ago");
    expect(relativeTime("2024-08-14T14:00:00", NOW)).toBe("2y ago");
  });

  it("is empty for an unparseable timestamp", () => {
    // Better a missing subtitle than "NaN ago" under a real conversation.
    expect(relativeTime("nonsense", NOW)).toBe("");
  });
});
