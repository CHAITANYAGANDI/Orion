import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The first screen inside a new account.
 *
 * <p>An onboarding earns its place by being skippable and by only asking for
 * things the product reads. Both of those are asserted here, and the second one
 * is the assertion that will fail first if somebody adds a "what is your role"
 * step later.
 */

const save = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ push: vi.fn() }));
const identity = vi.hoisted(() => ({
  mode: "clerk",
  profile: { name: "", email: "", imageUrl: "", provider: "", hasPassword: true },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

vi.mock("@/components/auth-gate", () => ({
  // The gate has its own tests. Here it would only stop anything rendering.
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => identity }));

vi.mock("@/lib/api", () => ({
  useUpdatePreferencesMutation: () => [save],
  useGetLanguagesQuery: () => ({
    data: [
      { code: "en", name: "English", nativeName: "English", rightToLeft: false },
      { code: "ja", name: "Japanese", nativeName: "日本語", rightToLeft: false },
    ],
    isLoading: false,
  }),
}));

import WelcomePage from "@/app/welcome/page";

beforeEach(() => {
  vi.clearAllMocks();
  identity.mode = "clerk";
  // An account made here, which owns its name. The Google case is its own test.
  identity.profile = { name: "", email: "", imageUrl: "", provider: "", hasPassword: true };
  save.mockReturnValue({ unwrap: () => Promise.resolve({}) });
});

describe("what it asks", () => {
  it("asks for a name and a language, and nothing else", async () => {
    render(<WelcomePage />);

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    // Nothing that Orion has nowhere to put.
    expect(screen.queryByLabelText(/company|team|role|how did you hear/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("radio", { name: /Detect automatically/ })).toBeInTheDocument();
  });

  it("fills the name in rather than asking for it twice", async () => {
    // An account made here can be given a name at sign-up time by other means;
    // where one is known, this step is a confirmation.
    identity.profile = { ...identity.profile, name: "Ada Lovelace" };
    render(<WelcomePage />);

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace"));
  });

  it("does not ask a Google account for a name Google already holds", async () => {
    /*
     * Settings tells this person their name comes from Google and disables the
     * field. Asking for it here would be the product contradicting itself two
     * screens apart -- and saving it would write a copy into Orion's column
     * that then outranks Google's on every screen.
     */
    identity.profile = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      imageUrl: "",
      provider: "google",
      hasPassword: false,
    };
    render(<WelcomePage />);

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    // Straight to the question it does not already know the answer to.
    expect(screen.getByRole("radio", { name: /Detect automatically/ })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  });

  it("never saves a name for an account that does not own one", async () => {
    identity.profile = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      imageUrl: "",
      provider: "google",
      hasPassword: false,
    };
    render(<WelcomePage />);
    await userEvent.click(await screen.findByRole("radio", { name: /Japanese/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Just take me in/ }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ defaultLanguage: "ja" }));
  });

  it("keeps auto-detect as the default language", () => {
    render(<WelcomePage />);
    void userEvent.click(screen.getByRole("button", { name: /Continue/ }));

    // Detection is right for most people; this step is for the case where a
    // quiet opening minute would fool it.
    return waitFor(() =>
      expect(screen.getByRole("radio", { name: /Detect automatically/ })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });
});

describe("getting out of it", () => {
  it("can be skipped from the first step", async () => {
    render(<WelcomePage />);

    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/home"));
  });

  it("saves what was chosen on the way through", async () => {
    render(<WelcomePage />);
    await userEvent.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.click(await screen.findByRole("radio", { name: /Japanese/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await userEvent.click(await screen.findByRole("button", { name: /Just take me in/ }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ displayName: "Ada Lovelace", defaultLanguage: "ja" }),
    );
    expect(nav.push).toHaveBeenCalledWith("/home");
  });

  it("lets somebody in even when the preference will not save", async () => {
    /*
     * Both of these have sound defaults and their own page in Settings.
     * Refusing to open the product because a preference failed would be the
     * worst possible first minute.
     */
    save.mockReturnValue({ unwrap: () => Promise.reject(new Error("offline")) });
    render(<WelcomePage />);
    await userEvent.type(screen.getByLabelText("Name"), "Ada");

    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/home"));
  });

  it("offers a first recording, an import, or straight in", async () => {
    render(<WelcomePage />);
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Continue/ }));

    expect(await screen.findByRole("button", { name: /Record a meeting/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import a file/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Just take me in/ })).toBeInTheDocument();
  });
});
