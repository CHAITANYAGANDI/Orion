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
  onConfirmIdentity: vi.fn(),
};

function show(props: Partial<React.ComponentProps<typeof ChangeEmailDialog>> = {}) {
  return render(
    <ChangeEmailDialog
      open
      current="ada@example.com"
      sentTo={null}
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
      <ChangeEmailDialog open current="ada@example.com" sentTo="chaitanya2000@gmaill.com" {...handlers} />,
    );
    rerender(<ChangeEmailDialog open current="ada@example.com" sentTo={null} {...handlers} />);

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
  it("asks for the password when Clerk does", () => {
    show({ needsPassword: true });

    expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
  });

  it("says why it is asking, since nothing else on this screen wanted a password", () => {
    show({ needsPassword: true });

    expect(screen.getByText(/how an account is taken/)).toBeInTheDocument();
  });

  it("hands the password over and nothing else", async () => {
    show({ needsPassword: true });

    await userEvent.type(screen.getByLabelText("Current password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /Confirm$/ }));

    expect(handlers.onConfirmIdentity).toHaveBeenCalledWith("hunter2");
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("is not in the way of anybody already inside the window", () => {
    // Most people are. Asking everybody every time would be a password typed
    // for nothing on the way to a screen that would have opened anyway.
    show();

    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New email")).toBeInTheDocument();
  });

  it("takes precedence over the step it interrupted", () => {
    // The refusal can arrive with an address already pending from an earlier
    // go. One field at a time, and it is the one Clerk is waiting for.
    show({ needsPassword: true, sentTo: "new@example.com" });

    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("shows a wrong password where it can be seen", () => {
    show({ needsPassword: true, error: "That password is not right." });

    expect(screen.getByRole("alert")).toHaveTextContent("That password is not right.");
  });
});
