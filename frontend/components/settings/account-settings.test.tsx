import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Account Settings.
 *
 * What matters here is the frame rather than the contents — each tab has its own
 * tests. Two things:
 *
 * The whole tab bar is always visible, whichever tab is open. Tabs that appeared
 * and disappeared depending on where you were would make "where do I change…" a
 * hunt again, which is the thing this page exists to end.
 *
 * And only the open tab is mounted. Plans reads usage; somebody changing their
 * name should not pay for it.
 *
 * There were six tabs and there are two. Four went with the features they
 * configured, and the URLs of all four still have to resolve — a settings link
 * somebody bookmarked should show them settings rather than a blank pane, which
 * is what a catch-all route renders for a path it does not recognise.
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
vi.mock("@/components/settings/plans-tab", () => ({ PlansTab: stub("plans") }));

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

  it("shows both tabs, whichever one is open", () => {
    pathname = "/settings/plans";
    render(<AccountSettings />);

    for (const label of ["General", "Plans"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("offers none of the four tabs that were removed", () => {
    render(<AccountSettings />);

    // Each opened onto a feature that no longer exists, except Meetings, whose
    // two surviving sections moved onto General.
    for (const gone of ["Integrations", "Meetings", "Emails", "Security"]) {
      expect(screen.queryByRole("link", { name: gone })).not.toBeInTheDocument();
    }
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

    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute(
      "href",
      "/settings/general",
    );
    expect(screen.getByRole("link", { name: "Plans" })).toHaveAttribute(
      "href",
      "/settings/plans",
    );
  });

  it("marks the open tab for a screen reader, not only with a colour", () => {
    pathname = "/settings/plans";
    render(<AccountSettings />);

    expect(screen.getByRole("link", { name: "Plans" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
  });
});

describe("which tab is open", () => {
  it("opens on General at the bare path", () => {
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
  });

  it("opens the one the URL names", () => {
    pathname = "/settings/plans";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-plans")).toBeInTheDocument();
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
    pathname = "/settings/plans";
    render(<AccountSettings />);

    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith("plans");
  });

  it("still opens settings under the old /privacy URL", () => {
    // RETENTION_APPLIED notifications still link there and those rows cannot be
    // rewritten. Security is gone, so it lands on General — which is settings,
    // rather than the blank pane a catch-all renders for a path it does not
    // recognise.
    pathname = "/privacy";
    render(<AccountSettings />);
    expect(screen.getByTestId("tab-general")).toBeInTheDocument();
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
