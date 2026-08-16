import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Creating a folder.
 *
 * Two things a naming dialog gets wrong. It accepts an empty name, and the rail
 * grows a row nobody can tell from the next one. Or the server refuses the name,
 * the dialog closes anyway, and whatever was typed is gone — the one part of the
 * exchange the person actually contributed.
 */
const { create, update, toastError } = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
}));

let failure: unknown = null;

vi.mock("@/lib/api", () => ({
  useCreateProjectMutation: () => [
    (body: { name: string }) => {
      create(body);
      return {
        unwrap: () =>
          failure ? Promise.reject(failure) : Promise.resolve({ id: "prj_1", name: body.name }),
      };
    },
    { isLoading: false },
  ],
  useUpdateProjectMutation: () => [
    (arg: { id: string; body: { name: string } }) => {
      update(arg);
      return {
        unwrap: () =>
          failure ? Promise.reject(failure) : Promise.resolve({ id: arg.id, ...arg.body }),
      };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { FolderDialog } from "@/components/folder-dialog";

function Harness({ onCreated }: { onCreated?: (f: { id: string }) => void } = {}) {
  return (
    <FolderDialog
      open
      onOpenChange={onOpenChange}
      onCreated={onCreated as never}
    />
  );
}

const onOpenChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  failure = null;
});

describe("the form", () => {
  it("asks for one thing and says what it is asking for", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Create a folder" })).toBeInTheDocument();
    expect(screen.getByLabelText("Enter a name for this folder")).toBeInTheDocument();
  });

  it("will not create an unnamed folder", () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("will not create one named out of whitespace either", async () => {
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "   ");

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});

describe("creating", () => {
  it("sends the trimmed name and closes", async () => {
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "  Client ABC  ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Client ABC" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hands back what was made, for whoever asked for it", async () => {
    const onCreated = vi.fn();
    render(<Harness onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "Q3");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "prj_1", name: "Q3" }));
  });

  it("submits on Enter, since one field and a keyboard is the whole interaction", async () => {
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "Q3{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Q3" }));
  });
});

describe("when it is refused", () => {
  it("keeps the dialog open with the name still in it", async () => {
    failure = { data: { message: "A folder called Q3 already exists." } };
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "Q3");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("A folder called Q3 already exists."));
    // Closing here would throw away the only part of this the person typed.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText(/name for this folder/)).toHaveValue("Q3");
  });

  it("says something useful when the server says nothing", async () => {
    failure = { status: 500 };
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "Q3");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't create that folder."));
  });
});

describe("renaming", () => {
  function Rename() {
    return (
      <FolderDialog
        open
        onOpenChange={onOpenChange}
        folder={{ id: "prj_7", name: "Client ABC" }}
      />
    );
  }

  it("opens on the name it already has", () => {
    render(<Rename />);

    // Made to retype the whole name, somebody fixing a typo introduces two.
    expect(screen.getByLabelText(/name for this folder/)).toHaveValue("Client ABC");
    expect(screen.getByRole("heading", { name: "Rename folder" })).toBeInTheDocument();
  });

  it("saves the new name against the folder it was opened on", async () => {
    render(<Rename />);

    await userEvent.clear(screen.getByLabelText(/name for this folder/));
    await userEvent.type(screen.getByLabelText(/name for this folder/), "ABC Ltd");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ id: "prj_7", body: { name: "ABC Ltd" } }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the new name is taken", async () => {
    failure = { data: { message: "You already have a folder called “ABC Ltd”." } };
    render(<Rename />);

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("backing out", () => {
  it("closes without creating anything", async () => {
    render(<Harness />);

    await userEvent.type(screen.getByLabelText(/name for this folder/), "Q3");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(create).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
