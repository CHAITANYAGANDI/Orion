import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";

function show(over: Partial<React.ComponentProps<typeof ChangePasswordDialog>> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ChangePasswordDialog open onClose={onClose} onSubmit={onSubmit} {...over} />,
  );
  return { onSubmit, onClose, view };
}

async function fill(current: string, next: string, confirm: string) {
  if (current) await userEvent.type(screen.getByLabelText("Current password"), current);
  if (next) await userEvent.type(screen.getByLabelText("New password"), next);
  if (confirm) await userEvent.type(screen.getByLabelText("Confirm new password"), confirm);
}

describe("the checklist", () => {
  it("lists all four rules before anything is typed", () => {
    show();
    expect(screen.getByText("At least 8 characters")).toBeInTheDocument();
    expect(screen.getByText("At least 1 uppercase letter")).toBeInTheDocument();
    expect(screen.getByText("At least 1 lowercase letter")).toBeInTheDocument();
    expect(screen.getByText("At least 1 number")).toBeInTheDocument();
  });

  it("marks rules as they are met, one at a time", async () => {
    show();
    await userEvent.type(screen.getByLabelText("New password"), "abcdefgh");

    // Length and lowercase satisfied; the other two not.
    const met = screen.getAllByText("Met:").length;
    expect(met).toBe(2);
  });

  it("says met or not met in words, not only by icon", async () => {
    // A tick and a cross differ by shape, and roughly one man in twelve cannot
    // rely on the colour that reinforces it.
    show();
    await userEvent.type(screen.getByLabelText("New password"), "Abcdefg1");

    expect(screen.getAllByText("Met:")).toHaveLength(4);
    expect(screen.queryByText("Not met:")).not.toBeInTheDocument();
  });
});

describe("Update", () => {
  it("is unavailable until the form is complete", () => {
    show();
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("says why it is unavailable", async () => {
    show();
    await fill("OldPass1", "NewPass99", "");

    expect(screen.getByRole("button", { name: "Update" })).toHaveAttribute(
      "title",
      expect.stringMatching(/confirm/i),
    );
  });

  it("submits the current and new password once everything is satisfied", async () => {
    const { onSubmit } = show();
    await fill("OldPass1", "NewPass99", "NewPass99");

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(onSubmit).toHaveBeenCalledWith("OldPass1", "NewPass99");
  });

  it("stays unavailable when the two new entries disagree", async () => {
    show();
    await fill("OldPass1", "NewPass99", "NewPass98");

    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("cannot be pressed twice while a change is in flight", async () => {
    const { onSubmit } = show({ busy: true });
    await fill("OldPass1", "NewPass99", "NewPass99");

    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("the fields", () => {
  it("hides every entry by default", () => {
    show();
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    }
  });

  it("reveals one without revealing the others", async () => {
    // Reveal exists because the alternative is people choosing a password they
    // can type blind, which is a shorter one.
    show();
    await userEvent.click(screen.getByRole("button", { name: "Show new password" }));

    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
  });

  it("tells the browser which box is which, so a manager fills them correctly", () => {
    show();
    expect(screen.getByLabelText("Current password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });
});

describe("what it does not keep", () => {
  it("shows the provider's refusal", () => {
    show({ error: "Incorrect password." });
    expect(screen.getByText("Incorrect password.")).toBeInTheDocument();
  });

  it("empties the fields when it closes, so nothing is left in memory", async () => {
    const { view } = show();
    await fill("OldPass1", "NewPass99", "NewPass99");

    view.rerender(
      <ChangePasswordDialog open={false} onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    view.rerender(
      <ChangePasswordDialog open onClose={vi.fn()} onSubmit={vi.fn()} />,
    );

    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
  });

  it("does not submit on cancel", async () => {
    const { onSubmit, onClose } = show();
    await fill("OldPass1", "NewPass99", "NewPass99");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
