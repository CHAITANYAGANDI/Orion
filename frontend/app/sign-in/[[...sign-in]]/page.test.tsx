import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Signing in, on Reverie's own form.
 *
 * <p>The form is ours and the credential is Clerk's, so what is asserted here
 * is the half we now own: that nothing on screen belongs to anybody else, that
 * a failure is reported in our words, and that the URL cannot send somebody
 * somewhere they did not ask to go.
 */

const clerk = vi.hoisted(() => ({
  isLoaded: true,
  create: vi.fn(),
  authenticateWithRedirect: vi.fn(),
  attemptFirstFactor: vi.fn(),
  setActive: vi.fn(),
}));

const nav = vi.hoisted(() => ({ push: vi.fn(), search: "" }));

vi.mock("@clerk/nextjs", () => ({
  useSignIn: () => ({
    isLoaded: clerk.isLoaded,
    signIn: {
      create: clerk.create,
      authenticateWithRedirect: clerk.authenticateWithRedirect,
      attemptFirstFactor: clerk.attemptFirstFactor,
    },
    setActive: clerk.setActive,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import SignInPage from "@/app/sign-in/[[...sign-in]]/page";

async function signIn(email = "ada@example.com", password = "hunter22") {
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clerk.isLoaded = true;
  nav.search = "";
  clerk.create.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
});

describe("what the screen shows", () => {
  it("never mentions Clerk", async () => {
    // The whole point of owning the form. This screen is the first thing
    // anybody sees, and it used to carry somebody else's name at the foot of
    // it.
    const { container } = render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    expect(container.textContent).not.toMatch(/clerk/i);
  });

  it("asks for an email and a password, and nothing else", async () => {
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    const labels = screen.getAllByText(/^(Email|Password|Username|Name)$/).map((el) => el.textContent);
    expect(labels).toEqual(["Email", "Password"]);
  });

  it("lets a password manager fill it", async () => {
    // `current-password` rather than `new-password` is what makes a manager
    // offer to fill rather than to generate.
    render(<SignInPage />);

    expect(await screen.findByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  });
});

describe("signing in", () => {
  it("opens the session and goes to the app", async () => {
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    await signIn();

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_1" }));
    expect(nav.push).toHaveBeenCalledWith("/home");
  });

  it("hands Google the round trip back to this app", async () => {
    render(<SignInPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Continue with Google/ }));

    expect(clerk.authenticateWithRedirect).toHaveBeenCalledWith({
      strategy: "oauth_google",
      redirectUrl: "/sso-callback",
      redirectUrlComplete: "/home",
    });
  });

  it("says what went wrong in Reverie's words", async () => {
    clerk.create.mockRejectedValue({ errors: [{ code: "form_password_incorrect" }] });
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    await signIn();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That email and password do not match an account.");
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("does not strand somebody on a step it cannot draw", async () => {
    // A second factor, most likely. Owning the form means owning the states it
    // does not handle, and saying so beats a button that silently does nothing.
    clerk.create.mockResolvedValue({ status: "needs_second_factor" });
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    await signIn();

    expect(await screen.findByRole("alert")).toHaveTextContent(/another step/i);
  });
});

describe("where it sends you afterwards", () => {
  it("returns to the page that was asked for", async () => {
    // The middleware puts it on the URL, so a bookmarked meeting opens the
    // meeting rather than the top of the app.
    nav.search = "redirect_url=%2Fmeetings%2Fmtg_1";
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    await signIn();

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/meetings/mtg_1"));
  });

  it.each([
    ["another origin", "https://evil.example.com"],
    ["a protocol-relative host", "//evil.example.com"],
    ["javascript", "javascript:alert(1)"],
  ])("refuses %s and goes home instead", async (_label, target) => {
    /*
     * An open redirect on a sign-in page is worth more to somebody than a
     * broken one: a link to Reverie's real sign-in that lands on a copy of it is
     * a credible way to collect passwords. Only a path, and never `//`, which
     * the browser reads as a host.
     */
    nav.search = `redirect_url=${encodeURIComponent(target)}`;
    render(<SignInPage />);
    await screen.findByRole("button", { name: "Sign in" });

    await signIn();

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/home"));
  });
});

describe("a forgotten password", () => {
  it("asks for a code without losing the address already typed", async () => {
    render(<SignInPage />);
    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");

    await userEvent.click(screen.getByRole("button", { name: "Forgot?" }));

    expect(clerk.create).not.toHaveBeenCalled();
    // The address survives the change of step -- retyping it would be the form
    // forgetting what it was just told.
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(screen.getByRole("button", { name: "Send code" })).toBeInTheDocument();
  });

  it("sets a new password and signs in with it", async () => {
    clerk.attemptFirstFactor.mockResolvedValue({ status: "complete", createdSessionId: "sess_2" });
    render(<SignInPage />);
    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Forgot?" }));
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));

    await userEvent.type(await screen.findByLabelText("Code"), "123456");
    await userEvent.type(screen.getByLabelText("New password"), "a-better-one");
    await userEvent.click(screen.getByRole("button", { name: /Set password/ }));

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_2" }));
  });

  it("comes back to the sign-in form", async () => {
    render(<SignInPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Forgot?" }));

    await userEvent.click(screen.getByRole("button", { name: "Back to sign in" }));

    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
