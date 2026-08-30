import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangeEmailDialog } from "@/components/settings/change-email-dialog";

/**
 * Changing the address you sign in with.
 *
 * <h2>The bug most of this pins</h2>
 *
 * <p>A code step with no way back fails at the exact thing the two-step design
 * exists to protect against. Mistype the domain and the send succeeds —
 * `gmaill.com` is a real place as far as the mail system is concerned — the
 * screen says a code is on its way, and nothing arrives. There was then nothing
 * to do but Cancel and start again, with no clue what went wrong, because the
 * address that was typed was no longer on screen to be read back.
 */

const handlers = {
  onClose: vi.fn(),
  onSend: vi.fn(),
  onResend: vi.fn(),
  onRetype: vi.fn(),
  onConfirm: vi.fn(),
  onIdentityCode: vi.fn(),
  onIdentityPassword: vi.fn(),
  onResendIdentityCode: vi.fn(),
};

/** What Clerk offered when it asked for proof. Both factors, code first. */
const BOTH = {
  emailCode: { emailAddressId: "idn_1", address: "ada@example.com" },
  password: true,
};

function show(props: Partial<React.ComponentProps<typeof ChangeEmailDialog>> = {}) {
  return render(
    <ChangeEmailDialog
      open
      current="ada@example.com"
      sentTo={null}
      challenge={null}
      {...handlers}
      {...props}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("choosing the new address", () => {
  it("sends a code to what was typed", async () => {
    show();

    await userEvent.type(screen.getByLabelText("New email"), "  new@example.com  ");
    await userEvent.click(screen.getByRole("button", { name: /Send code/ }));

    expect(handlers.onSend).toHaveBeenCalledWith("new@example.com");
  });

  it("names the address being replaced, so nobody changes the wrong account", () => {
    show();

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("asks about a domain one letter off", async () => {
    // The whole of this report: a code was sent, delivered, and read by nobody,
    // because it went to a domain that was not the one meant.
    show();

    await userEvent.type(screen.getByLabelText("New email"), "chaitanya2000@gmaill.com");

    expect(
      screen.getByRole("button", { name: "chaitanya2000@gmail.com" }),
    ).toBeInTheDocument();
  });

  it("fixes it on one click", async () => {
    show();
    await userEvent.type(screen.getByLabelText("New email"), "chaitanya2000@gmaill.com");

    await userEvent.click(screen.getByRole("button", { name: "chaitanya2000@gmail.com" }));

    expect(screen.getByLabelText("New email")).toHaveValue("chaitanya2000@gmail.com");
  });

  it("never refuses an address on the strength of a guess", async () => {
    /*
     * Plenty of real domains are one letter from a famous one. A hint beside
     * the field can be ignored; a form that argues with somebody about their
     * own address is worse than the typo it was guarding against.
     */
    show();
    await userEvent.type(screen.getByLabelText("New email"), "ada@gmaill.com");

    await userEvent.click(screen.getByRole("button", { name: /Send code/ }));

    expect(handlers.onSend).toHaveBeenCalledWith("ada@gmaill.com");
  });

  it("says nothing about an address that is already right", async () => {
    show();

    await userEvent.type(screen.getByLabelText("New email"), "ada@gmail.com");

    expect(screen.queryByText(/Did you mean/)).not.toBeInTheDocument();
  });
});

describe("waiting for a code that has not come", () => {
  const SENT = { sentTo: "new@example.com" };

  it("can ask for another one", async () => {
    // Mail is delayed, mail lands in spam, and mail goes to the wrong domain.
    // A screen that says "we sent you a code" has to be able to send another.
    show(SENT);

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    expect(handlers.onResend).toHaveBeenCalled();
  });

  it("says the second one went, rather than succeeding silently", () => {
    show({ ...SENT, resent: true });

    expect(screen.getByRole("status")).toHaveTextContent(/A new code is on its way/);
  });

  it("mentions the spam folder, which is where the first one usually is", () => {
    show({ ...SENT, resent: true });

    expect(screen.getByRole("status")).toHaveTextContent(/spam/i);
  });

  it("can go back and correct the address", async () => {
    show(SENT);

    await userEvent.click(screen.getByRole("button", { name: "Use a different address" }));

    expect(handlers.onRetype).toHaveBeenCalled();
    // Cancel is not the answer: it closes the whole thing and loses the change.
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("keeps what was typed when it goes back, so one character can be fixed", async () => {
    const { rerender } = show();
    await userEvent.type(screen.getByLabelText("New email"), "chaitanya2000@gmaill.com");
    await userEvent.click(screen.getByRole("button", { name: /Send code/ }));

    // The code step, and then the way back out of it.
    rerender(
      <ChangeEmailDialog
        open
        current="ada@example.com"
        sentTo="chaitanya2000@gmaill.com"
        challenge={null}
        {...handlers}
      />,
    );
    rerender(
      <ChangeEmailDialog open current="ada@example.com" sentTo={null} challenge={null} {...handlers} />,
    );

    // An empty field would mean retyping an address nobody can see to compare.
    expect(screen.getByLabelText("New email")).toHaveValue("chaitanya2000@gmaill.com");
  });

  it("says the old address still signs you in", () => {
    // Until the code lands nothing has changed, and somebody who abandons this
    // halfway needs to know they are not locked out.
    show(SENT);

    expect(screen.getByText(/ada@example.com still signs you in/)).toBeInTheDocument();
  });

  it("confirms with the code", async () => {
    show(SENT);

    await userEvent.type(screen.getByLabelText("Code"), " 123456 ");
    await userEvent.click(screen.getByRole("button", { name: /Confirm address/ }));

    expect(handlers.onConfirm).toHaveBeenCalledWith("123456");
  });

  it("offers neither way out while something is in flight", () => {
    show({ ...SENT, busy: true });

    expect(screen.getByRole("button", { name: "Send another code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use a different address" })).toBeDisabled();
  });

  it("shows what went wrong where it can be seen", () => {
    show({ ...SENT, error: "That code did not confirm the address." });

    expect(screen.getByRole("alert")).toHaveTextContent(/did not confirm/);
  });
});

/**
 * Clerk refuses to add an address to a session that has not proved a first
 * factor lately, and answers with "You need to provide additional verification
 * to perform this operation" — a sentence that arrived in a dialog with no
 * field to provide it in.
 */
describe("proving it is you first", () => {
  it("sends a code rather than asking anybody to recall a password", () => {
    // The proof that needs nothing remembered. It goes to the address already
    // signing this person in, which they can by definition read.
    show({ challenge: BOTH });

    expect(screen.getByLabelText("Code")).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });

  it("names the address the proof code went to", () => {
    // Not the new one. Sending the check to an address nobody has proved yet
    // would be handing it to whoever typed it.
    show({ challenge: BOTH, sentTo: "new@example.com" });

    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/the address you sign in with now/)).toBeInTheDocument();
  });

  it("hands the code over", async () => {
    show({ challenge: BOTH });

    await userEvent.type(screen.getByLabelText("Code"), " 123456 ");
    await userEvent.click(screen.getByRole("button", { name: /Confirm$/ }));

    expect(handlers.onIdentityCode).toHaveBeenCalledWith("123456");
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("can send that code again", async () => {
    show({ challenge: BOTH });

    await userEvent.click(screen.getByRole("button", { name: "Send another code" }));

    expect(handlers.onResendIdentityCode).toHaveBeenCalled();
    // Not the other resend: that one belongs to the new address, which does not
    // exist yet at this point in the flow.
    expect(handlers.onResend).not.toHaveBeenCalled();
  });

  it("offers the password to anybody who would rather type it", async () => {
    show({ challenge: BOTH });

    await userEvent.click(screen.getByRole("button", { name: "Use your password instead" }));

    expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("empties the field on the swap, since a password is not a half-typed code", async () => {
    show({ challenge: BOTH });
    await userEvent.type(screen.getByLabelText("Code"), "1234");

    await userEvent.click(screen.getByRole("button", { name: "Use your password instead" }));

    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("comes back to the code", async () => {
    show({ challenge: BOTH });
    await userEvent.click(screen.getByRole("button", { name: "Use your password instead" }));

    await userEvent.click(screen.getByRole("button", { name: "Email me a code instead" }));

    expect(screen.getByLabelText("Code")).toBeInTheDocument();
  });

  it("hands the password over when that is what was used", async () => {
    show({ challenge: BOTH });
    await userEvent.click(screen.getByRole("button", { name: "Use your password instead" }));

    await userEvent.type(screen.getByLabelText("Current password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /Confirm$/ }));

    expect(handlers.onIdentityPassword).toHaveBeenCalledWith("hunter2");
  });

  it("asks for the password when Clerk offers no code, with no swap to offer", () => {
    show({ challenge: { emailCode: null, password: true } });

    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /instead/ })).not.toBeInTheDocument();
  });

  it("is not in the way of anybody already inside the window", () => {
    // Most people are. Asking everybody every time would be a proof supplied
    // for nothing on the way to a screen that would have opened anyway.
    show();

    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New email")).toBeInTheDocument();
  });

  it("takes precedence over the step it interrupted", () => {
    // The refusal can arrive with an address already pending from an earlier
    // go. One field at a time, and it is the one Clerk is waiting for.
    show({ challenge: BOTH, sentTo: "new@example.com" });

    expect(screen.getByLabelText("Code")).toHaveAttribute("id", "reverify");
    expect(screen.queryByRole("button", { name: "Use a different address" })).not.toBeInTheDocument();
  });

  it("shows a refused proof where it can be seen", () => {
    show({ challenge: BOTH, error: "That code is not right." });

    expect(screen.getByRole("alert")).toHaveTextContent("That code is not right.");
  });
});
