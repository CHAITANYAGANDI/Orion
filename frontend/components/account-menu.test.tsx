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
