import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The profile dialog: the photo, the email, and the way into a password change.
 *
 * jsdom has no 2D canvas, so the image downscale itself is stubbed and what is
 * tested is the wiring around it — that a pick becomes the avatar, that a
 * failure says so instead of silently keeping the old one, and that removing it
 * really removes it.
 *
 * The rest is about restraint. Neither credential belongs to Orion, and the
 * dialog has to be clear about which of them this deployment can change at all.
 */
const { avatarFromFile } = vi.hoisted(() => ({ avatarFromFile: vi.fn() }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
const { changePassword } = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock("@/lib/avatar", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/avatar")>();
  return { ...real, avatarFromFile };
});

vi.mock("@/lib/account-actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/account-actions")>();
  return { ...real, changePassword };
});

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

// The camera needs getUserMedia, which jsdom does not have. Its own behaviour
// is covered in camera-capture.test.tsx; here it only has to not explode.
vi.mock("@/components/settings/camera-capture", () => ({
  CameraCapture: ({ open }: { open: boolean }) =>
    open ? <div data-testid="camera-open" /> : null,
}));

import { ProfileDialog, type ProfileForm } from "@/components/settings/profile-dialog";
import { identityPermissions } from "@/lib/identity-owner";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const EMPTY: ProfileForm = {
  displayName: "Priya Raman",
  email: "priya@example.com",
  avatarUrl: "",
};

/**
 * The three kinds of account, which this dialog now tells apart.
 *
 * <p>It used to ask one question -- "is this deployment using Clerk?" -- and a
 * Google sign-in and an email-and-password sign-up answer that identically. So
 * the address was locked for both and both were offered a password dialog,
 * when in fact one owns all three fields and the other owns none of them.
 */
const DEV = { mode: "dev", provider: "", hasPassword: false };
const ORION = { mode: "clerk", provider: "", hasPassword: true };
const GOOGLE = { mode: "clerk", provider: "google", hasPassword: false };

function show(initial: ProfileForm = EMPTY, credential = DEV) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <ProfileDialog
      open
      initial={initial}
      permissions={identityPermissions(credential)}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  avatarFromFile.mockResolvedValue(PNG);
  changePassword.mockResolvedValue(undefined);
});

describe("what it asks for", () => {
  it("no longer asks for a department, a role or pronouns", () => {
    show();
    expect(screen.queryByLabelText("Department")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pronouns")).not.toBeInTheDocument();
  });

  it("saves the name, email and photo together", async () => {
    const { onSave } = show();

    await userEvent.clear(screen.getByLabelText("Email"));
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(onSave).toHaveBeenCalledWith({
      displayName: "Priya Raman",
      email: "new@example.com",
      avatarUrl: "",
    });
  });
});

describe("the photo", () => {
  it("shows initials until there is one", () => {
    show();
    expect(screen.getByText("PR")).toBeInTheDocument();
  });

  it("turns a chosen file into the avatar", async () => {
    const { onSave } = show();

    const file = new File(["x"], "me.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("avatar-file"), file);

    await waitFor(() => expect(avatarFromFile).toHaveBeenCalledWith(file));
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: PNG }));
  });

  it("says why a file was rejected instead of failing quietly", async () => {
    // A .png that is not really a png. The input's `accept` already turns away
    // the obvious wrong types, so the failure that actually reaches this code
    // is one that only shows up when the bytes are decoded.
    const { AvatarError } = await import("@/lib/avatar");
    avatarFromFile.mockRejectedValue(new AvatarError("That image could not be read."));
    const { onSave } = show();

    await userEvent.upload(
      screen.getByTestId("avatar-file"),
      new File(["not really a png"], "broken.png", { type: "image/png" }),
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("That image could not be read."),
    );

    // And the profile keeps whatever it had rather than being left half-set.
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: "" }));
  });

  it("lets a failed pick be retried with the same file", async () => {
    // The input is cleared after a failure. Without that, choosing the same
    // file again fires no change event and the retry silently does nothing.
    show();
    const input = screen.getByTestId("avatar-file") as HTMLInputElement;
    const { AvatarError } = await import("@/lib/avatar");
    avatarFromFile.mockRejectedValueOnce(new AvatarError("That image could not be read."));

    await userEvent.upload(input, new File(["x"], "me.png", { type: "image/png" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    expect(input.value).toBe("");
  });

  it("removes the picture when asked", async () => {
    const { onSave } = show({ ...EMPTY, avatarUrl: PNG });

    await userEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    // Empty string, not undefined: the server reads blank as "remove it", and
    // omitting the field would mean "leave it alone" — the opposite.
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: "" }));
  });

  it("offers no way to remove a photo that is not there", () => {
    show();
    expect(screen.queryByRole("button", { name: "Remove photo" })).not.toBeInTheDocument();
  });

  it("opens the camera on request", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    expect(screen.getByTestId("camera-open")).toBeInTheDocument();
  });
});

describe("the email", () => {
  it("can be edited inline where Orion owns the column", async () => {
    show(EMPTY, DEV);
    expect(screen.getByLabelText("Email")).toBeEnabled();
  });

  it("cannot be touched at all when Google owns it", () => {
    /*
     * Not politeness: the server refuses it too, because the column is
     * rewritten from the sign-in token on the next request, so an accepted edit
     * would appear to work and silently revert. And there is no Change button
     * either -- the address lives at Google, and a dialog here could only fail.
     */
    show(EMPTY, GOOGLE);

    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByText(/Your email comes from Google/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change email" })).not.toBeInTheDocument();
  });

  it("is changed at the provider, with a code, for an account made here", async () => {
    // The address is the credential under Clerk -- it is what sign-in matches
    // on -- so it cannot be a text field with a Save button beside it. A typo
    // would lock somebody out of their own workspace.
    show(EMPTY, ORION);

    expect(screen.getByLabelText("Email")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Change email" }));

    expect(screen.getByRole("heading", { name: "Change email" })).toBeInTheDocument();
    expect(screen.getByLabelText("New email")).toBeInTheDocument();
  });

  it("never sends an address Orion's own API would refuse", async () => {
    // `UserService.cleanAccountEmail` throws under an identity provider. The
    // name has to save anyway, so the address is stripped rather than sent and
    // rejected along with everything else in the same request.
    const { onSave } = show(EMPTY, ORION);

    await userEvent.clear(screen.getByLabelText("Full Name"));
    await userEvent.type(screen.getByLabelText("Full Name"), "Ada");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada", email: EMPTY.email }),
    );
  });
});

describe("the name", () => {
  it("is editable for an account made here", () => {
    show(EMPTY, ORION);
    expect(screen.getByLabelText("Full Name")).toBeEnabled();
  });

  it("is Google's when the account is Google's", () => {
    show(EMPTY, GOOGLE);

    expect(screen.getByLabelText("Full Name")).toBeDisabled();
    expect(screen.getByText(/Your name comes from Google/)).toBeInTheDocument();
  });
});

describe("the password", () => {
  it("is never a typed field on this form", () => {
    show(EMPTY, ORION);
    expect(screen.getByLabelText("Password")).toBeDisabled();
  });

  it("cannot be changed in a session that has no password", () => {
    show(EMPTY, DEV);

    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(screen.getByText(/no password to change/)).toBeInTheDocument();
  });

  it("is not offered at all to somebody who signs in with Google", () => {
    /*
     * The other half of the bug. This dialog was offered to every Clerk
     * account, and `updatePassword` needs a current password -- which a Google
     * account does not have, anywhere. The button could only ever fail.
     */
    show(EMPTY, GOOGLE);

    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(screen.getByText(/You sign in with Google, so there is no password/)).toBeInTheDocument();
  });

  it("opens the change dialog under a provider", async () => {
    show(EMPTY, ORION);

    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(screen.getByRole("heading", { name: "Change Password" })).toBeInTheDocument();
  });

  it("hands the current and new password to the provider", async () => {
    show(EMPTY, ORION);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    await userEvent.type(screen.getByLabelText("Current password"), "OldPass1");
    await userEvent.type(screen.getByLabelText("New password"), "NewPass99");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "NewPass99");
    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith("OldPass1", "NewPass99"),
    );
  });

  it("shows the provider's own refusal rather than a generic one", async () => {
    const { AccountActionError } = await import("@/lib/account-actions");
    changePassword.mockRejectedValue(
      new AccountActionError("That password has appeared in a data breach."),
    );
    show(EMPTY, ORION);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    await userEvent.type(screen.getByLabelText("Current password"), "OldPass1");
    await userEvent.type(screen.getByLabelText("New password"), "NewPass99");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "NewPass99");
    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    // Its errors are the only part of this a person can act on.
    await waitFor(() =>
      expect(screen.getByText(/appeared in a data breach/)).toBeInTheDocument(),
    );
    // And the dialog stays open so they can try another one.
    expect(screen.getByRole("heading", { name: "Change Password" })).toBeInTheDocument();
  });
});

describe("discarding", () => {
  it("does not save on cancel", async () => {
    const { onSave, onClose } = show();

    await userEvent.type(screen.getByLabelText("Full Name"), " and more");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
