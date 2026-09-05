import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The account button.
 *
 * <p>Two items, and the shortness is the point: the plan, privacy and the
 * settings themselves are all tabs of one page now, so listing them here as
 * well would be listing the same page three times under three names.
 *
 * <h2>What moved, and why these tests open the menu</h2>
 *
 * <p>This used to be a 256px button at the foot of a navigation rail, with the
 * name and the second line printed on its face. The rail is gone; the trigger
 * is now the avatar alone at the end of a 48px band, and every fact that was on
 * the button is the first two lines of the menu it opens.
 *
 * <p>So the assertions below are the same assertions — never the user id, the
 * settings name beats the provider's, dev mode says it is dev — asked one click
 * later. That is deliberate: the facts are what these tests are for, and
 * checking them where they now live is the only way the move stays honest. The
 * one thing that is checked on the button itself is its accessible name, which
 * is the whole of what a picture-only control offers a screen reader.
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
  // The allowance lives inside this menu now, so the module it reads has to be
  // answerable here. A real row rather than `undefined`: a skeleton would let
  // the card render as a grey block and pass every assertion below.
  useGetUsageQuery: () => ({
    data: { plan: "FREE", minutesUsed: 12, minutesLimit: 100, importsUsed: 1, importsLimit: 3 },
  }),
}));

import { AccountMenu } from "@/components/account-menu";

/** The trigger, found the way a screen reader finds it. */
function trigger() {
  return screen.getByRole("button", { name: /Priya|Ada|Your account|ada@|user_3IU/ });
}

async function openMenu() {
  render(<AccountMenu />);
  await userEvent.click(trigger());
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clerk, because that is where the bug was: a real sign-in with a real
  // identity provider, and a button showing a primary key.
  mode = "clerk";
  profile = { displayName: null, avatarUrl: null };
  identity = { name: "", email: "", imageUrl: "" };
});

describe("who it says you are", () => {
  it("never shows the user id, however little else is known", async () => {
    /*
     * THE bug, reported from production: this read
     * `user_3IUiqZSNuF0gbjwWA...` for somebody who had just signed in with
     * Google, which does not read as "you" -- it reads as somebody else's
     * account.
     *
     * It got there honestly. The two things it preferred were both empty:
     * `display_name` is only ever set by hand in Settings, and `email` is null
     * unless a Clerk JWT template is configured to send one. So the fallback
     * was the primary key, in the place a name goes.
     */
    await openMenu();

    expect(screen.queryByText(/user_3IU/)).not.toBeInTheDocument();
    expect(screen.getByText("Your account")).toBeInTheDocument();
  });

  it("uses the name the identity provider knows", async () => {
    // Signing in with Google hands Clerk a name. It was in the browser the
    // whole time; nothing was reading it.
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "" };
    await openMenu();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByText(/user_3IU/)).not.toBeInTheDocument();
  });

  it("falls back to the address before it gives up on a name", async () => {
    identity = { name: "", email: "ada@example.com", imageUrl: "" };
    await openMenu();

    // A poor name, but a true one, and the one that catches being signed in as
    // the wrong person.
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("lets a name chosen in Settings win over the provider's", async () => {
    // Somebody who has typed a name has said what they want to be called.
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "" };
    profile = { displayName: "Priya Raman", avatarUrl: null };
    await openMenu();

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  });

  it("says the address underneath, when the line above is a name", async () => {
    // The second line is what catches being signed in as the wrong person, and
    // it is the reason the name did not simply replace it when this shrank to
    // an avatar. Both are here, one under the other.
    identity = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: "" };
    await openMenu();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("does not say the same fact twice when the address is the name", async () => {
    identity = { name: "", email: "ada@example.com", imageUrl: "" };
    await openMenu();

    expect(screen.getAllByText("ada@example.com")).toHaveLength(1);
    expect(screen.getByText("Signed in")).toBeInTheDocument();
  });

  it("still shows the dev user id in dev mode, which is the identity there", async () => {
    // Not the same thing at all. In dev the id is how you switch tenant, it is
    // typed by hand, and the line under it says "Development session". It is
    // the identity rather than a stand-in for one.
    mode = "dev";
    await openMenu();

    expect(screen.getByText("user_3IUiqZSNuF0gbjwWA")).toBeInTheDocument();
    expect(screen.getByText("Development session")).toBeInTheDocument();
  });
});

describe("the button, which is only a picture", () => {
  it("carries the name as its accessible label", () => {
    // The whole of what a picture-only control offers a screen reader. Without
    // it the band ends in an unlabelled button.
    profile = { displayName: "Priya Raman", avatarUrl: null };
    render(<AccountMenu />);

    expect(screen.getByRole("button", { name: "Priya Raman" })).toBeInTheDocument();
  });

  it("is labelled even when nothing at all is known", () => {
    render(<AccountMenu />);

    expect(screen.getByRole("button", { name: "Your account" })).toBeInTheDocument();
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

  it("uses real initials, not the tail of an id", () => {
    profile = { displayName: "Chaitanyasai Gandi", avatarUrl: null };
    render(<AccountMenu />);

    // "CG", not "WA" or whatever the id happens to end with.
    expect(screen.getByText("CG")).toBeInTheDocument();
  });

  /**
   * <p>This replaces a test on a chevron that used to sit beside the name. The
   * bug it was written for was real — the glyph never turned, because nothing
   * read Radix's `data-state` — and the fix survives the arrow being dropped:
   * the trigger still says whether it is open, in the one way that is announced
   * rather than merely drawn.
   */
  it("says whether it is open", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    // Held rather than looked up twice. Radix marks everything outside the open
    // menu `aria-hidden`, so the trigger is unreachable by role the moment it
    // has done its job -- which is correct behaviour and would read here as the
    // button having disappeared.
    const button = trigger();
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
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
 * The allowance, which has nowhere else to be.
 *
 * <p>It was the row above this button in the navigation rail. With the rail
 * gone the only alternative was a settings tab, and an allowance that is only
 * visible on a page nobody opens until they have run out is not a meter — it is
 * an explanation delivered after the fact.
 */
describe("the allowance", () => {
  it("is in the menu, with the count and the way to the plans", async () => {
    await openMenu();

    const link = screen.getByRole("link", { name: /minutes transcribed/ });
    expect(link).toHaveAttribute("href", "/settings/plans");
    expect(link).toHaveTextContent("12 of 100");
  });

  it("is not a menu item, because a count is not an action", async () => {
    await openMenu();

    // Guards the assertion above about there being exactly two menu items: if
    // this ever becomes one, that test fails for a reason nobody would guess
    // from its name.
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).not.toContain(expect.stringContaining("minutes"));
  });
});
