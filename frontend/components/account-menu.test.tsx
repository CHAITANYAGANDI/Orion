import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The account button.
 *
 * Two items, and the shortness is the point: the plan, privacy and the settings
 * themselves are all tabs of one page now, so listing them here as well would be
 * listing the same page three times under three names.
 */
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

let mode: "dev" | "clerk";
let profile: { displayName: string | null; avatarUrl: string | null; email?: string | null };
/** What the identity provider knows -- a name and a picture, from Google. */
let identity: { name: string; email: string; imageUrl: string };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "user_3IUiqZSNuF0gbjwWA", mode, signOut, profile: identity }),
}));

vi.mock("@/lib/api", () => ({
  useGetPreferencesQuery: () => ({ data: profile }),
}));

import { AccountMenu } from "@/components/account-menu";

async function openMenu() {
  render(<AccountMenu />);
  await userEvent.click(screen.getByRole("button", { name: /Priya|Your account|ada@/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clerk, because that is where the bug was: a real sign-in with a real
  // identity provider, and a button showing a primary key.
  mode = "clerk";
  profile = { displayName: null, avatarUrl: null };
  identity = { name: "", email: "", imageUrl: "" };
});

describe("the button", () => {
  it("never shows the user id, however little else is known", () => {
    /*
     * THE bug, reported from production: this button read
     * `user_3IUiqZSNuF0gbjwWA...` for somebody who had just signed in with
     * Google, which does not read as "you" -- it reads as somebody else's
     * account.
     *
     * It got there honestly. The two things it preferred were both empty:
     * `display_name` is only ever set by hand in Settings, and `email` is null
     * unless a Clerk JWT template is configured to send one. So the fallback
     * was the primary key, in the place a name goes.
     */
    render(<AccountMenu />);

    expect(screen.queryByText(/user_3IU/)).not.toBeInTheDocument();
    expect(screen.getByText("Your account")).toBeInTheDocument();
  });

  it("uses the name the identity provider knows", () => {
    // Signing in with Google hands Clerk a name. It was in the browser the
    // whole time; nothing was reading it.
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "" };
    render(<AccountMenu />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByText(/user_3IU/)).not.toBeInTheDocument();
  });

  it("falls back to the address before it gives up on a name", () => {
    identity = { name: "", email: "ada@example.com", imageUrl: "" };
    render(<AccountMenu />);

    // A poor name, but a true one, and the one that catches being signed in as
    // the wrong person.
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("lets a name chosen in Settings win over the provider's", () => {
    // Somebody who has typed a name has said what they want to be called.
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "" };
    profile = { displayName: "Priya Raman", avatarUrl: null };
    render(<AccountMenu />);

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  });

  it("shows the Google picture when there is no uploaded one", () => {
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "https://img.clerk.com/ada" };
    const { container } = render(<AccountMenu />);

    expect(container.querySelector("img")).toHaveAttribute("src", "https://img.clerk.com/ada");
  });

  it("shows the profile photo instead of initials", () => {
    // A picture that only appeared in the dialog that set it would read as a
    // feature that did not work.
    profile = { displayName: "Priya Raman", avatarUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const { container } = render(<AccountMenu />);

    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  });

  it("still shows the dev user id in dev mode, which is the identity there", () => {
    // Not the same thing at all. In dev the id is how you switch tenant, it is
    // typed by hand, and the line under it says "Development session". It is
    // the identity rather than a stand-in for one.
    mode = "dev";
    render(<AccountMenu />);

    expect(screen.getByText("user_3IUiqZSNuF0gbjwWA")).toBeInTheDocument();
    expect(screen.getByText("Development session")).toBeInTheDocument();
  });

  it("uses real initials, not the tail of an id", () => {
    profile = { displayName: "Chaitanyasai Gandi", avatarUrl: null };
    render(<AccountMenu />);

    // "CG", not "WA" or whatever the id happens to end with.
    expect(screen.getByText("CG")).toBeInTheDocument();
  });
});

describe("the menu", () => {
  it("offers the settings page and the way out, and nothing else", async () => {
    await openMenu();

    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).toEqual(["Account Settings", "Logout"]);
  });

  it("goes to Account Settings", async () => {
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Account Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("logs out", async () => {
    await openMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Logout" }));

    // Not decorative even in a dev build: closing an account calls the same
    // path, and with nothing behind it the browser carried on as the user it
    // had just deleted.
    expect(signOut).toHaveBeenCalled();
  });
});

/**
 * The arrow on the trigger.
 *
 * <p>It never moved. Radix writes `data-state` on the trigger and nothing was
 * reading it, so the one glyph saying the button opens something said the same
 * thing whether the menu was open or shut.
 *
 * <p>Asserted on the trigger's own state rather than on a computed rotation:
 * jsdom applies no Tailwind, so what is checkable is that the icon is wired to
 * the attribute and that the attribute flips.
 */
describe("the arrow", () => {
  it("is wired to whether the menu is open", () => {
    render(<AccountMenu />);

    const icon = screen.getByRole("button", { name: /Your account/ }).querySelector("svg");
    expect(icon).toHaveClass("group-data-[state=open]:rotate-180");
  });

  it("turns over when the menu opens", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    const trigger = screen.getByRole("button", { name: /Your account/ });
    expect(trigger).toHaveAttribute("data-state", "closed");

    await user.click(trigger);

    // The trigger carries the state and `group` on it carries it to the icon,
    // so this flipping is the rotation happening.
    expect(trigger).toHaveAttribute("data-state", "open");
    expect(trigger).toHaveClass("group");
  });
});
