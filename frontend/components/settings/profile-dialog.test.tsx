import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The profile dialog, and mostly the photo.
 *
 * The text fields are covered through the settings tab, which is where a person
 * actually reaches them. What is pinned here is the picture: jsdom has no 2D
 * canvas, so the downscale itself is stubbed and what is tested is the wiring
 * around it — that a pick becomes the avatar, that a failure says so instead of
 * silently keeping the old one, and that removing it really removes it.
 */
const { avatarFromFile } = vi.hoisted(() => ({ avatarFromFile: vi.fn() }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("@/lib/avatar", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/avatar")>();
  return { ...real, avatarFromFile };
});

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

// The camera needs getUserMedia, which jsdom does not have. Its own behaviour
// is covered in camera-capture.test.tsx; here it only has to not explode.
vi.mock("@/components/settings/camera-capture", () => ({
  CameraCapture: ({ open }: { open: boolean }) =>
    open ? <div data-testid="camera-open" /> : null,
}));

import { ProfileDialog, type ProfileForm } from "@/components/settings/profile-dialog";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const EMPTY: ProfileForm = {
  displayName: "Priya Raman",
  pronouns: "",
  department: "IT",
  jobRole: "Individual contributor",
  avatarUrl: "",
};

function show(initial: ProfileForm = EMPTY) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <ProfileDialog
      open
      initial={initial}
      email="priya@example.com"
      passwordNote="Managed by your sign-in provider."
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  avatarFromFile.mockResolvedValue(PNG);
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

describe("what it will not let you change", () => {
  it("shows the email and the password without letting either be typed into", () => {
    show();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
  });

  it("says who holds the password", () => {
    show();
    expect(screen.getByText("Managed by your sign-in provider.")).toBeInTheDocument();
  });
});

describe("discarding", () => {
  it("does not save on cancel", async () => {
    const { onSave, onClose } = show();

    await userEvent.type(screen.getByLabelText("Pronouns"), "she/her");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
