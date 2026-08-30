"use client";

/**
 * Who you are, and the two things that are about the account rather than the
 * work.
 *
 * Everything that used to hang off this menu — the plan, privacy, the settings
 * themselves — is now a tab of Account Settings, so listing them here as well
 * would be listing the same page three times under three names. Two items: the
 * page, and the way out.
 *
 * Signing out in a dev build does something real rather than nothing. Dev mode
 * has no session to end, but it does have a stored identity, and until this the
 * "sign out" after closing an account left the browser still browsing as the
 * user it had just deleted — which is how deleted probe accounts kept coming
 * back as empty rows.
 */

import Link from "next/link";
import { ChevronDown, LogOut, Settings as SettingsIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useGetPreferencesQuery } from "@/lib/api";
import { initialsOf } from "@/lib/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function AccountMenu() {
  const { userId, mode, signOut, profile } = useAuth();
  // The profile is already fetched by the settings page and cached, so this
  // costs nothing on any screen that has been there; elsewhere it is one small
  // request for the thing a person most expects to recognise.
  const prefs = useGetPreferencesQuery();
  /*
   * Three sources, in order of who is most entitled to answer "what is my
   * name": what this person typed into Settings, then what they told their
   * identity provider, then nothing.
   *
   * <p>The id is not in that list any more, and that is the fix. This button
   * used to render `user_3IUiqZSNuF0gbjwWA…` for anybody who signed in with
   * Google — because `users.display_name` is only ever set by hand and
   * `users.email` is null unless a Clerk JWT template sends one — and an opaque
   * id in the place a name goes does not read as "you". It reads as somebody
   * else's account, which is exactly how it was reported.
   */
  const name = prefs.data?.displayName?.trim() || profile.name || null;
  const photo = prefs.data?.avatarUrl || profile.imageUrl || null;
  /** The address, which is the line that catches being signed in as the wrong person. */
  const account = prefs.data?.email || profile.email || (mode === "dev" ? userId : "");
  // Real initials, not the tail of an opaque id: "k5" said nothing about
  // anybody, and a person who has told us their name should see it.
  const initials = initialsOf(name, account || userId);

  /**
   * The two lines on the button, which must not be the same line twice.
   *
   * <p>With no name at all the address is promoted to the top line -- and then
   * repeating it underneath is a button that says one fact twice. The second
   * line only carries the address when the first one is carrying a name.
   */
  const label = name || account || "Your account";
  const detail =
    mode === "dev"
      ? "Development session"
      : account && account !== label
        ? account
        : "Signed in";

  return (
    <div className="px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors hover:bg-accent"
          >
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                {initials}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {/* Never the id. An address is a poor name but a true one; with
                    neither, "Your account" says what the button is for without
                    claiming to know who is behind it. */}
                {label}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{detail}</span>
            </span>
            {/* Radix writes data-state on the trigger, which is the only thing
                that knows whether the menu is showing -- `open` lives inside
                DropdownMenu and is never handed out. `group` on the button is
                what lets the icon read it. */}
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            {account || "Signed in"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <SettingsIcon className="mr-2 h-4 w-4" /> Account Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => signOut?.()}>
            <LogOut className="mr-2 h-4 w-4" /> Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
