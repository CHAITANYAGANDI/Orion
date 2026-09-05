"use client";

/**
 * Who you are, and the things that are about the account rather than the work.
 *
 * <p>Everything that used to hang off this menu — the plan, privacy, the
 * settings themselves — is a tab of Account Settings, so listing them here as
 * well would be listing the same page three times under three names. Two items:
 * the page, and the way out.
 *
 * <p>Signing out in a dev build does something real rather than nothing. Dev
 * mode has no session to end, but it does have a stored identity, and until
 * this the "sign out" after closing an account left the browser still browsing
 * as the user it had just deleted — which is how deleted probe accounts kept
 * coming back as empty rows.
 *
 * <h2>The button is the picture, and everything else moved inside</h2>
 *
 * <p>This was a 256px-wide button at the foot of a navigation rail: avatar,
 * name, a second line, a chevron. The rail is gone, and what replaced it is
 * 48px of band whose whole discipline is that it does not spend width on things
 * that are not being read. So the trigger is the avatar — the one part of this
 * anybody recognises at a glance — and the name, the address and "Development
 * session" are the first two lines of the menu it opens.
 *
 * <p>Nothing was dropped in the move, which matters more than it sounds: the
 * second line is what catches being signed in as the wrong person, and in a dev
 * build it is what says the identity is typed rather than authenticated.
 *
 * <p>The allowance came with it. It used to sit in the row above this button;
 * an allowance nobody sees until they have run out of it is worse than no meter
 * at all. It stays a link rather than becoming a menu item, so the count reads
 * as information — and the menu is controlled here precisely so that following
 * it closes the menu, which an uncontrolled Radix popover would not do for a
 * plain anchor.
 */

import * as React from "react";
import Link from "next/link";
import { LogOut, Settings as SettingsIcon } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useGetPreferencesQuery } from "@/lib/api";
import { initialsOf } from "@/lib/avatar";
import { PlanUsage } from "@/components/plan-usage";
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
  // Controlled only so the allowance link can close it; see the header comment.
  const [open, setOpen] = React.useState(false);
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
   * The two lines, which must not be the same line twice.
   *
   * <p>With no name at all the address is promoted to the first line -- and
   * then repeating it underneath says one fact twice. The second line only
   * carries the address when the first one is carrying a name.
   */
  const label = name || account || "Your account";
  const detail =
    mode === "dev"
      ? "Development session"
      : account && account !== label
        ? account
        : "Signed in";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          /* Named, because the picture is the whole of the button. Without this
             a screen reader reaches the end of the band and finds an unlabelled
             control — and the name is exactly what somebody is checking when
             they go looking for this. */
          aria-label={label}
          className="flex shrink-0 items-center justify-center rounded-full opacity-90 transition-opacity duration-press ease-soft hover:opacity-100 data-[state=open]:opacity-100"
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" className="h-7 w-7 rounded-full object-cover" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {initials}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          {/* Never the id. An address is a poor name but a true one; with
              neither, "Your account" says what this is without claiming to know
              who is behind it. */}
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {detail}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <PlanUsage onNavigate={() => setOpen(false)} className="mx-1 mb-1" />
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
  );
}
