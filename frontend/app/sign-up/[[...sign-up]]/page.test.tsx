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
 *
 * <p>The second group is about the screen after it. Clerk's sign-up completes
 * only once every required field is present, so a correct code can leave the
 * attempt short of an account — and this form used to report that as "check the
 * code and try again". Re-entering it then failed with "This verification has
 * already been verified", and so did Send another code, and the screen had no
 * way out of itself.
 */

const clerk = vi.hoisted(() => ({
  isLoaded: true,
  create: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn(),
  authenticateWithRedirect: vi.fn(),
  setActive: vi.fn(),
  /* What the in-memory resource reads as when it is consulted directly. */
  state: { status: "missing_requirements", missingFields: [] as string[], createdSessionId: null },
}));

const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useSignUp: () => ({
    isLoaded: clerk.isLoaded,
    signUp: {
      ...clerk.state,
      create: clerk.create,
      update: clerk.update,
      reload: clerk.reload,
      prepareEmailAddressVerification: clerk.prepare,
      attemptEmailAddressVerification: clerk.attempt,
      authenticateWithRedirect: clerk.authenticateWithRedirect,
    },
    setActive: clerk.setActive,
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

import SignUpPage from "@/app/sign-up/[[...sign-up]]/page";

const OPEN = { status: "missing_requirements", missingFields: [], createdSessionId: null };
const FINISHED = { status: "complete", missingFields: [], createdSessionId: "sess_new" };

/** Already verified, which is Clerk's way of saying the code worked. */
const TAKEN = { errors: [{ code: "verification_already_verified" }] };

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText("Email"), "ada@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "a-good-password");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

async function reachTheCode() {
  render(<SignUpPage />);
  await fillAndSubmit();
  await screen.findByLabelText("Code");
}

async function enterTheCode() {
  await userEvent.type(screen.getByLabelText("Code"), "123456");
  await userEvent.click(screen.getByRole("button", { name: /Confirm and continue/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clerk.isLoaded = true;
  clerk.state = { status: "missing_requirements", missingFields: [], createdSessionId: null };
  clerk.create.mockResolvedValue(OPEN);
  clerk.update.mockResolvedValue(OPEN);
  clerk.reload.mockResolvedValue(OPEN);
  clerk.prepare.mockResolvedValue(OPEN);
  clerk.attempt.mockResolvedValue(FINISHED);
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
    await reachTheCode();

    await enterTheCode();

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
    expect(nav.push).toHaveBeenCalledWith("/welcome");
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

  it("signs somebody in on the spot where the instance verifies nothing", async () => {
    // Uncommon, and real: with email verification switched off there is no code
    // to wait for, and stopping at a code screen would strand the account.
    clerk.create.mockResolvedValue(FINISHED);
    render(<SignUpPage />);

    await fillAndSubmit();

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
    expect(clerk.prepare).not.toHaveBeenCalled();
  });
});

describe("a username the instance requires", () => {
  it("is derived from the address rather than asked for", async () => {
    /*
     * Turning usernames on in Clerk used to break this form outright: the
     * sign-up stayed at missing_requirements for ever, the correct code was
     * reported as wrong, and there was no field on screen that could fix it.
     */
    clerk.create.mockResolvedValue({ ...OPEN, missingFields: ["username"] });
    render(<SignUpPage />);

    await fillAndSubmit();

    await waitFor(() => expect(clerk.update).toHaveBeenCalledTimes(1));
    expect(clerk.update.mock.calls[0][0].username).toMatch(/^ada-[0-9a-f]{6}$/);
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  });

  it("is filled in before a code is spent, not after", async () => {
    clerk.create.mockResolvedValue({ ...OPEN, missingFields: ["username"] });
    render(<SignUpPage />);

    await fillAndSubmit();

    await waitFor(() => expect(clerk.prepare).toHaveBeenCalled());
    expect(clerk.update.mock.invocationCallOrder[0]).toBeLessThan(
      clerk.prepare.mock.invocationCallOrder[0],
    );
  });

  it("is left alone when the instance does not want one", async () => {
    render(<SignUpPage />);

    await fillAndSubmit();

    await waitFor(() => expect(clerk.prepare).toHaveBeenCalled());
    expect(clerk.update).not.toHaveBeenCalled();
  });
});

describe("a code that worked but did not finish the sign-up", () => {
  it("does not send anybody back to a code Clerk already accepted", async () => {
    // The bug, exactly: the address is verified, so re-entering the code fails
    // with "already verified" and so does asking for another one.
    clerk.attempt.mockResolvedValue({ ...OPEN, missingFields: ["first_name"] });
    await reachTheCode();

    await enterTheCode();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/a first name/);
    expect(alert).not.toHaveTextContent(/code/i);
  });

  it("carries on when Clerk answers that the code was already used", async () => {
    /*
     * A lost response, a double submit, or a second press after an earlier
     * failure all land here. It is a success reported as a failure -- so read
     * where the sign-up actually got to instead of showing an error.
     */
    clerk.attempt.mockRejectedValue(TAKEN);
    clerk.reload.mockResolvedValue(FINISHED);
    await reachTheCode();

    await enterTheCode();

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
    expect(nav.push).toHaveBeenCalledWith("/welcome");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never shows Clerk's own words for it", async () => {
    // "This verification has already been verified." reports a success as a
    // failure, on a screen whose only two buttons both produce it.
    clerk.attempt.mockRejectedValue(TAKEN);
    clerk.reload.mockRejectedValue(new Error("offline"));
    clerk.state = { status: "missing_requirements", missingFields: ["first_name"], createdSessionId: null };
    await reachTheCode();

    await enterTheCode();

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/already been verified/i);
    expect(alert).toHaveTextContent(/a first name/);
  });

  it("finishes a sign-up that only needed a field it can fill", async () => {
    clerk.attempt.mockResolvedValue({ ...OPEN, missingFields: ["username"] });
    clerk.update.mockResolvedValue(FINISHED);
    await reachTheCode();

    await enterTheCode();

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
  });

  it("sends a finished account with no session to the sign-in form", async () => {
    clerk.attempt.mockResolvedValue({ ...FINISHED, createdSessionId: null });
    await reachTheCode();

    await enterTheCode();

    expect(await screen.findByRole("alert")).toHaveTextContent(/Sign in/);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
});

describe("another code", () => {
  it("says it went, rather than succeeding silently", async () => {
    // A button that does nothing visible is a button that looks broken, and the
    // next thing anybody does is press it again.
    await reachTheCode();

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/A new code is on its way/);
    expect(clerk.prepare).toHaveBeenCalledTimes(2);
  });

  it("gets out of the screen when there is no code left to send", async () => {
    /*
     * Clerk refuses a resend on a verification it has already taken. Reporting
     * that as an error is what made this screen a dead end: both buttons fail,
     * and the account is finished or nearly so the whole time.
     */
    await reachTheCode();
    clerk.prepare.mockRejectedValue(TAKEN);
    clerk.reload.mockResolvedValue(FINISHED);

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    await waitFor(() => expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" }));
  });

  it("reports a recovery that fails rather than throwing into nothing", async () => {
    // The rescue path can fail too. An unhandled rejection here would leave the
    // button reading "Sending..." for ever with no error anywhere on screen.
    await reachTheCode();
    clerk.prepare.mockRejectedValue(TAKEN);
    clerk.reload.mockResolvedValue({ ...OPEN, missingFields: ["username"] });
    clerk.update.mockRejectedValue({ errors: [{ code: "too_many_requests" }] });

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
    expect(screen.getByRole("button", { name: "Send another code" })).toBeEnabled();
  });

  it("cannot be pressed twice over", async () => {
    await reachTheCode();
    let release = () => {};
    clerk.prepare.mockReturnValue(new Promise((resolve) => (release = () => resolve(OPEN))));

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Confirm and continue/ })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send another code" })).toBeEnabled(),
    );
  });

  it("offers a different address, which starts again", async () => {
    await reachTheCode();

    await userEvent.click(screen.getByRole("button", { name: "Use a different email" }));

    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
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
