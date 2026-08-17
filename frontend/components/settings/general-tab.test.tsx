import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreferencesResponse } from "@/lib/types";

/**
 * Account Settings → General.
 *
 * Three claims worth holding onto.
 *
 * <i>Two of these fields are descriptive and two are not.</i> Department and
 * Role are recorded and read by nothing. The name is matched against the owner
 * of every action item, and the language is sent with every transcription job —
 * so the test that matters is that saving one does not quietly clear another,
 * which is what a form that sends its whole state on every keystroke would do.
 *
 * <i>Email and password are shown and not editable.</i> Neither is Recallix's to
 * change; a development session has no sign-in provider and therefore no
 * password at all, and an Edit control over them would be a promise the product
 * cannot keep.
 *
 * <i>Nothing in the footer is invented.</i> No commit means "dev build" rather
 * than a hash that resolves to nothing, and the legal line does not appear at
 * all unless somebody has supplied real URLs — Recallix ships no terms of
 * service of its own.
 */
const { update, toastError } = vi.hoisted(() => ({
  update: vi.fn(),
  toastError: vi.fn(),
}));

let prefs: PreferencesResponse;
let mode: "dev" | "clerk";
let failure: unknown = null;

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ userId: "usr_dev", mode }) }));

vi.mock("@/lib/api", () => ({
  useGetPreferencesQuery: () => ({ data: prefs, isLoading: false }),
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", nativeName: "English", rightToLeft: false },
      { code: "es", name: "Spanish", nativeName: "Español", rightToLeft: false },
    ],
  }),
  useUpdatePreferencesMutation: () => [
    (body: unknown) => {
      update(body);
      return { unwrap: () => (failure ? Promise.reject(failure) : Promise.resolve({})) };
    },
    { isLoading: false },
  ],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("@/lib/hooks", () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => ({ notifyProcessingDone: false }),
}));

import { GeneralTab } from "@/components/settings/general-tab";

beforeEach(() => {
  vi.clearAllMocks();
  failure = null;
  mode = "dev";
  prefs = {
    email: "priya@example.com",
    autoEmailRecap: false,
    recapEmail: null,
    effectiveRecapEmail: "priya@example.com",
    displayName: "Priya Raman",
    department: "IT",
    jobRole: "Individual contributor",
    defaultLanguage: null,
    taskReminders: false,
    mutedNotifications: [],
  };
});

describe("who you are", () => {
  it("shows the name, address, department and role", () => {
    render(<GeneralTab />);

    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
    expect(screen.getByText("priya@example.com")).toBeInTheDocument();
    expect(screen.getByText("IT")).toBeInTheDocument();
    expect(screen.getByText("Individual contributor")).toBeInTheDocument();
  });

  it("says where the password lives rather than pretending to hold one", () => {
    mode = "clerk";
    render(<GeneralTab />);

    expect(screen.getByText("Managed by your sign-in provider")).toBeInTheDocument();
  });

  it("is honest that a development session has no password", () => {
    render(<GeneralTab />);

    expect(screen.getByText("Development session — no password")).toBeInTheDocument();
  });

  it("says so when the provider gave no address", () => {
    prefs = { ...prefs, email: null };
    render(<GeneralTab />);

    // Dev sessions have no provider, and "no email" reads as a broken feature
    // unless the page says why.
    expect(screen.getByText(/No address from your sign-in provider/)).toBeInTheDocument();
  });

  it("is read-only until Edit is pressed", () => {
    render(<GeneralTab />);

    expect(screen.queryByLabelText("Full Name")).not.toBeInTheDocument();
  });
});

describe("editing", () => {
  async function openEditor() {
    render(<GeneralTab />);
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
  }

  it("opens on the values already there", async () => {
    await openEditor();

    expect(screen.getByLabelText("Full Name")).toHaveValue("Priya Raman");
    expect(screen.getByLabelText("Department")).toHaveValue("IT");
    expect(screen.getByLabelText("Role")).toHaveValue("Individual contributor");
  });

  it("offers no field for the two it cannot change", async () => {
    await openEditor();

    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });

  it("saves all three together, so changing one cannot clear another", async () => {
    await openEditor();

    await userEvent.clear(screen.getByLabelText("Department"));
    await userEvent.type(screen.getByLabelText("Department"), "Platform");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        displayName: "Priya Raman",
        department: "Platform",
        jobRole: "Individual contributor",
      }),
    );
  });

  it("keeps the form open when the save is refused", async () => {
    failure = { data: { message: "That name is too long" } };
    await openEditor();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That name is too long"));
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
  });

  it("backs out without saving", async () => {
    await openEditor();

    await userEvent.type(screen.getByLabelText("Full Name"), " and more");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("Priya Raman")).toBeInTheDocument();
  });
});

describe("language", () => {
  it("opens on detect, which is what an unset account does", () => {
    render(<GeneralTab />);

    expect(screen.getByLabelText("Default language")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
  });

  it("offers only what transcription supports", () => {
    render(<GeneralTab />);

    // The list is served rather than written here: a nineteenth entry would be
    // offering a transcript that cannot be made.
    expect(screen.getByRole("option", { name: "Spanish" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Telugu" })).not.toBeInTheDocument();
  });

  it("saves the code on its own, touching nothing else", async () => {
    render(<GeneralTab />);

    await userEvent.selectOptions(screen.getByLabelText("Default language"), "es");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ defaultLanguage: "es" }));
  });

  it("goes back to detecting", async () => {
    prefs = { ...prefs, defaultLanguage: "es" };
    render(<GeneralTab />);

    await userEvent.selectOptions(screen.getByLabelText("Default language"), "");

    await waitFor(() => expect(update).toHaveBeenCalledWith({ defaultLanguage: "" }));
  });
});

describe("the rest of the page", () => {
  it("sends vocabulary to where vocabulary is managed", () => {
    render(<GeneralTab />);

    expect(screen.getByRole("link", { name: /Manage Vocabulary/ })).toHaveAttribute(
      "href",
      "/settings/meetings",
    );
  });

  it("sends account deletion to where the export sits above it", () => {
    render(<GeneralTab />);

    // Closing an account is irreversible and exactly one thing makes it
    // recoverable. A second entry point that skipped the export would be the
    // wrong shortcut.
    const links = screen.getAllByRole("link", { name: "Delete account" });
    expect(links[0]).toHaveAttribute("href", "/settings/security");
  });

  it("names the build rather than inventing one", () => {
    render(<GeneralTab />);

    expect(screen.getByText(/^Version /)).toHaveTextContent("dev build");
  });

  it("shows no legal line when there are no documents to link to", () => {
    render(<GeneralTab />);

    // Recallix ships no terms of service of its own, and a link to a page that
    // does not exist is worse than no link.
    expect(screen.queryByText(/Terms of Service/)).not.toBeInTheDocument();
  });
});
