import { describe, it, expect, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, screen, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { readPreferences, writePreference } from "@/lib/preference-store";

/**
 * What signing out has to take with it.
 *
 * <p>Dev mode is the awkward case and the reason this file exists. Anything
 * stored per sign-in is stamped with a session key, and a read under a
 * different one gets nothing — which handles a session that expired, a sign-out
 * in another tab, and a second person on the same browser, without anyone
 * having to remember to call something.
 *
 * <p>Dev mode has no sessions. It signs back in under the same id, so the stamp
 * is unchanged and the whole mechanism silently does nothing. `signOut` has to
 * clear up after itself, and that is what is pinned here.
 *
 * <p>Only the dev provider is exercised: the Clerk one is loaded lazily and
 * needs a publishable key and the SDK to render at all. Its `signOut` makes the
 * same call, one line above `void signOut()`.
 */

/** Reads the context out so a test can drive it. */
function Probe() {
  const { sessionKey, isLoaded, signOut } = useAuth();
  return (
    <div>
      <span data-testid="session">{isLoaded ? sessionKey : "…"}</span>
      <button onClick={() => signOut?.()}>Sign out</button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // signOut navigates, which jsdom cannot do. The warning it logs is expected
  // and says nothing about whether this worked.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("signing out of dev mode", () => {
  it("names the sign-in it is currently under", async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    // The dev user id, because there is nothing else that distinguishes one dev
    // sign-in from another.
    expect(screen.getByTestId("session")).toHaveTextContent("usr_dev");
  });

  it("forgets the filters on the way out", async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    writePreference("usr_dev", "home.scope", "all");
    expect(readPreferences("usr_dev")["home.scope"]).toBe("all");

    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });

    // Signing back in as the same dev user produces the same stamp, so nothing
    // but this would put the filter back to its default.
    expect(readPreferences("usr_dev")).toEqual({});
  });
});
