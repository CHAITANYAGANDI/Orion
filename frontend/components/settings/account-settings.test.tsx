import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Account Settings.
 *
 * What matters here is the frame rather than the contents — each tab has its own
 * tests. Two things:
 *
 * The whole tab bar is always visible, whichever tab is open. Six tabs that
 * appeared and disappeared depending on where you were would make "where do I
 * change…" a hunt again, which is the thing this page exists to end.
 *
 * And only the open tab is mounted. Security counts every row a workspace owns
 * and Plans reads the usage period; somebody changing their recap address
 * should pay for neither.
 */
const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }));

let pathname = "/settings";

vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function stub(name: string) {
  return function Stub() {
    rendered(name);
    return <div data-testid={`tab-${name}`}>{name}</div>;
  };
}

vi.mock("@/components/settings/general-tab", () => ({ GeneralTab: stub("general") }));
vi.mock("@/components/settings/meetings-tab", () => ({ MeetingsTab: stub("meetings") }));
vi.mock("@/components/settings/plans-tab", () => ({ PlansTab: stub("plans") }));
vi.mock("@/components/settings/emails-tab", () => ({ EmailsTab: stub("emails") }));
vi.mock("@/components/settings/security-tab", () => ({ SecurityTab: stub("security") }));

import { AccountSettings } from "@/components/settings/account-settings";

beforeEach(() => {
  vi.clearAllMocks();
  pathname = "/settings";
});

describe("the frame", () => {
  it("is called what the page is", () => {
    render(<AccountSettings />);
    expect(screen.getByRole("heading", { name: "Account Settings" })).toBeInTheDocument();
  });

  it("shows all five tabs, whichever one is open", () => {
    pathname = "/settings/security";
    render(<AccountSettings />);

    for (const label of ["General", "Meetings", "Plans", "Emails", "Security"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("has no Integrations tab", () => {
    render(<AccountSettings />);

    // It held one thing, a calendar feed of deadlines, and that is gone. A tab
    // whose only content was removed is a tab that opens onto nothing.
    expect(screen.queryByRole("link", { name: "Integrations" })).not.toBeInTheDocument();
  });

  it("has no Templates tab", () => {
    render(<AccountSettings />);

    // A summary template is picked per meeting, on the upload page and from a
    // meeting's own summary. A tab here only ever listed them.
    expect(screen.queryByRole("link", { name: "Templates" })).not.toBeInTheDocument();
  });

  it("shows General rather than a blank pane under the old Templates URL", () => {
    pathname = "/settings/templates";
    render(<AccountSettings />);

    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
  });

  it("links each tab to its own URL, so one can be bookmarked or sent", () => {
    render(<AccountSettings />);

    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(screen.getByRole("link", { name: "Plans" })).toHaveAttribute(
      "href",
      "/settings/plans",
    );
  });

  it("marks the open tab for a screen reader, not only with a colour", () => {
    pathname = "/settings/emails";
    render(<AccountSettings />);

    expect(screen.getByRole("link", { name: "Emails" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
  });
});

describe("which tab is open", () => {
  it("opens on General at the bare path", () => {
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
  });

  it("opens the one the URL names", () => {
    pathname = "/settings/meetings";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-meetings")).toBeInTheDocument();
  });

  it("shows General rather than a blank pane under the old Integrations URL", () => {
    // A bookmark from when the tab existed. It falls through to the default
    // like any other unrecognised settings path, rather than rendering nothing.
    pathname = "/settings/integrations";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
  });

  it("mounts only that one", () => {
    // Security counts every row the workspace owns, and Plans reads usage.
    // Neither is paid for by somebody opening Emails.
    pathname = "/settings/emails";
    render(<AccountSettings />);

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith("emails");
  });

  it("opens Security under the old /privacy URL", () => {
    // Notifications written before this restructuring still link there.
    pathname = "/privacy";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-security")).toBeInTheDocument();
  });

  it("opens Plans under the old /billing URL", () => {
    pathname = "/billing";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-plans")).toBeInTheDocument();
  });

  it("falls back to General rather than a blank pane", () => {
    pathname = "/settings/whatever";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
  });
});
