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

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ userId: "usr_dev", mode, signOut }),
}));

import { AccountMenu } from "@/components/account-menu";

async function openMenu() {
  render(<AccountMenu />);
  await userEvent.click(screen.getByRole("button", { name: /usr_dev/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mode = "dev";
});

describe("the button", () => {
  it("says who you are", () => {
    render(<AccountMenu />);

    expect(screen.getByText("usr_dev")).toBeInTheDocument();
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
