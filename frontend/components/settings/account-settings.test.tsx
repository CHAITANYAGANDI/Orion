import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Account Settings.
 *
 * What matters here is the frame rather than the contents — each tab has its own
 * tests. Two things:
 *
 * The whole tab bar is always visible, whichever tab is open. Seven tabs that
 * appeared and disappeared depending on where you were would make "where do I
 * change…" a hunt again, which is the thing this page exists to end.
 *
 * And only the open tab is mounted. Templates costs a round trip to the AI
 * service and Security counts every row a workspace owns; somebody changing
 * their recap address should pay for neither.
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
vi.mock("@/components/settings/integrations-tab", () => ({ IntegrationsTab: stub("integrations") }));
vi.mock("@/components/settings/emails-tab", () => ({ EmailsTab: stub("emails") }));
vi.mock("@/components/settings/templates-tab", () => ({ TemplatesTab: stub("templates") }));
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

  it("shows all seven tabs, whichever one is open", () => {
    pathname = "/settings/integrations";
    render(<AccountSettings />);

    for (const label of [
      "General",
      "Meetings",
      "Plans",
      "Integrations",
      "Emails",
      "Templates",
      "Security",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("links each tab to its own URL, so one can be bookmarked or sent", () => {
    render(<AccountSettings />);

    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute(
      "href",
      "/settings/security",
    );
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
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
    pathname = "/settings/integrations";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-integrations")).toBeInTheDocument();
  });

  it("mounts only that one", () => {
    // Templates costs a round trip to the AI service; Security counts every row
    // the workspace owns. Neither is paid for by opening Emails.
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
