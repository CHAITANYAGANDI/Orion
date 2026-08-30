import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Creating an account.
 *
 * <p>The strongest assertions here are about what the form does <em>not</em>
 * ask for. A sign-up is the moment somebody is deciding whether this is worth
 * the trouble, and every field is a reason to close the tab — so a field that
 * exists has to be one the product reads back.
 */

const clerk = vi.hoisted(() => ({
  isLoaded: true,
  create: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn(),
  authenticateWithRedirect: vi.fn(),
  setActive: vi.fn(),
}));

const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useSignUp: () => ({
    isLoaded: clerk.isLoaded,
    signUp: {
      create: clerk.create,
      prepareEmailAddressVerification: clerk.prepare,
      attemptEmailAddressVerification: clerk.attempt,
      authenticateWithRedirect: clerk.authenticateWithRedirect,
    },
    setActive: clerk.setActive,
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "a-good-password");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clerk.isLoaded = true;
  clerk.create.mockResolvedValue({});
  clerk.prepare.mockResolvedValue({});
  clerk.attempt.mockResolvedValue({ status: "complete", createdSessionId: "sess_new" });
});

describe("what it refuses to ask for", () => {
  it("never asks for a username", () => {
    /*
     * There is nowhere to put one. No profile page, no @mention, no sharing,
     * one account per workspace -- so a username would be a required field that
     * nothing ever reads back, invented at the worst possible moment.
     */
    render(<SignUpPage />);

    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/username/i)).not.toBeInTheDocument();
  });

  it("asks for exactly two things", () => {
    render(<SignUpPage />);

    const fields = screen.getAllByRole("textbox").length + screen.getAllByLabelText(/password/i).length;
    expect(fields).toBe(2);
  });

  it("does not ask for a name, a company or a card", () => {
    // The name is asked for once, on the first screen inside, where it sits
    // beside the things that actually configure the account.
    render(<SignUpPage />);

    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/company|organisation|organization|team/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/card|payment/i)).not.toBeInTheDocument();
  });

  it("never mentions Clerk", () => {
    const { container } = render(<SignUpPage />);

    expect(container.textContent).not.toMatch(/clerk/i);
  });
});

describe("creating the account", () => {
  it("sends the address for verification rather than signing in straight away", async () => {
    render(<SignUpPage />);

    await fillAndSubmit();

    await waitFor(() =>
      expect(clerk.create).toHaveBeenCalledWith({
        emailAddress: "ada@example.com",
        password: "a-good-password",
      }),
    );
    expect(clerk.prepare).toHaveBeenCalledWith({ strategy: "email_code" });
    // Not a session yet: the address is unproven until the code comes back.
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it("names the address the code went to", async () => {
    render(<SignUpPage />);

    await fillAndSubmit();

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
  });

  it("finishes on the code and lands on the welcome screen", async () => {
    render(<SignUpPage />);
    await fillAndSubmit();

    await userEvent.type(await screen.findByLabelText("Code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: /Confirm and continue/ }));

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
    expect(nav.push).toHaveBeenCalledWith("/welcome");
  });

  it("offers another code and a different address", async () => {
    render(<SignUpPage />);
    await fillAndSubmit();

    await userEvent.click(await screen.findByRole("button", { name: "Send another code" }));
    expect(clerk.prepare).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("says an address is taken, and where to go instead", async () => {
    clerk.create.mockRejectedValue({ errors: [{ code: "form_identifier_exists" }] });
    render(<SignUpPage />);

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/already an account/i);
  });

  it("keeps a place for the bot check, which Clerk refuses the sign-up without", () => {
    const { container } = render(<SignUpPage />);

    expect(container.querySelector("#clerk-captcha")).toBeInTheDocument();
  });
});

describe("Google", () => {
  it("comes back through this app and into the welcome flow", async () => {
    render(<SignUpPage />);

    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));

    expect(clerk.authenticateWithRedirect).toHaveBeenCalledWith({
      strategy: "oauth_google",
      redirectUrl: "/sso-callback",
      redirectUrlComplete: "/welcome",
    });
  });
});
