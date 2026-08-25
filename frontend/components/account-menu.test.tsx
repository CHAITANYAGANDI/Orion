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
let profile: { displayName: string | null; avatarUrl: string | null };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_dev", mode, signOut }),
}));

vi.mock("@/lib/api", () => ({
  useGetPreferencesQuery: () => ({ data: profile }),
}));

import { AccountMenu } from "@/components/account-menu";

async function openMenu() {
  render(<AccountMenu />);
  await userEvent.click(screen.getByRole("button", { name: /Priya|usr_dev/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mode = "dev";
  profile = { displayName: null, avatarUrl: null };
});

describe("the button", () => {
  it("falls back to the user id when nothing is known", () => {
    render(<AccountMenu />);

    expect(screen.getByText("usr_dev")).toBeInTheDocument();
  });

  it("prefers the name over the id once there is one", () => {
    // An opaque id is not who you are. The whole reason the profile has a
    // name is so the product can stop showing people their primary key.
    profile = { displayName: "Priya Raman", avatarUrl: null };
    render(<AccountMenu />);

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.queryByText("usr_dev")).not.toBeInTheDocument();
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

    // "CG", not "v5" or whatever the id happens to end with.
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

    const icon = screen.getByRole("button", { name: /usr_dev/ }).querySelector("svg");
    expect(icon).toHaveClass("group-data-[state=open]:rotate-180");
  });

  it("turns over when the menu opens", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    const trigger = screen.getByRole("button", { name: /usr_dev/ });
    expect(trigger).toHaveAttribute("data-state", "closed");

    await user.click(trigger);

    // The trigger carries the state and `group` on it carries it to the icon,
    // so this flipping is the rotation happening.
    expect(trigger).toHaveAttribute("data-state", "open");
    expect(trigger).toHaveClass("group");
  });
});
