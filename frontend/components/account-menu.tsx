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
  const { userId, mode, signOut } = useAuth();
  // The profile is already fetched by the settings page and cached, so this
  // costs nothing on any screen that has been there; elsewhere it is one small
  // request for the thing a person most expects to recognise.
  const prefs = useGetPreferencesQuery();
  const name = prefs.data?.displayName || null;
  const photo = prefs.data?.avatarUrl || null;
  /*
   * The address, where there is one. `userId` is `user_2abc…` — an opaque
   * string that tells the reader nothing and cannot be checked against anything
   * they know. With real accounts the useful answer to "who am I signed in as"
   * is the email, and it is the one that catches signing in as the wrong
   * person. The id is the fallback, not the label.
   */
  const account = prefs.data?.email || (mode === "dev" ? userId : "");
  // Real initials, not the tail of an opaque id: "k5" said nothing about
  // anybody, and a person who has told us their name should see it.
  const initials = initialsOf(name, userId);

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
                {name || userId || "user"}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {mode === "dev" ? "Development session" : account || "Signed in"}
              </span>
            </span>
            {/* Radix writes data-state on the trigger, which is the only thing
                that knows whether the menu is showing -- `open` lives inside
                DropdownMenu and is never handed out. `group` on the button is
                what lets the icon read it. */}
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="truncate">{account || userId}</DropdownMenuLabel>
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
