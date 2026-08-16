"use client";

/**
 * General — who you are, and what Recallix is allowed to interrupt you about.
 *
 * The display name is the only field here that changes what the product can do
 * rather than how it behaves: nothing joins an account to a transcript, so
 * "which of these tasks are mine" is unanswerable until somebody says what they
 * are called in their own meetings.
 *
 * The notification switches sit here rather than under Emails because none of
 * them send mail — they decide what appears in the bell. The one browser-level
 * toggle is separated out and labelled as such, because a preference stored in
 * localStorage behaves differently from every other switch on this page and
 * quietly not applying on somebody's laptop is the kind of thing that reads as
 * a bug.
 */

import * as React from "react";
import { toast } from "sonner";
import { Bell, User } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { setNotifyProcessingDone } from "@/lib/uiSlice";
import {
  useGetUsageQuery,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetNotificationKindsQuery,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { settingsError, ToggleRow } from "@/components/settings/shared";

export function GeneralTab() {
  return (
    <div className="space-y-6">
      <ProfileCard />
      <NameCard />
      <NotificationsCard />
      <BrowserCard />
    </div>
  );
}

function ProfileCard() {
  const { userId, mode } = useAuth();
  const usage = useGetUsageQuery();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <User className="h-4 w-4 text-primary" /> Account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="account-id">User ID</Label>
          <Input id="account-id" value={userId} readOnly />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Auth mode:</span>
          <Badge variant="secondary">{mode}</Badge>
          {usage.data && <Badge>{usage.data.plan}</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The name you are called in your own meetings.
 *
 * Not a display name in the usual sense — it is matched against the owner on
 * every action item, which is the only thing that turns a list of promises into
 * "my tasks". Spelled the way the transcripts spell it, which is why the hint
 * says so rather than asking for a full legal name.
 */
function NameCard() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [name, setName] = React.useState<string | null>(null);

  // Seeded once, so a refetch cannot clobber what is being typed.
  const loaded = prefs.data;
  React.useEffect(() => {
    if (loaded && name === null) setName(loaded.displayName ?? "");
  }, [loaded, name]);

  async function save() {
    try {
      await update({ displayName: name ?? "" }).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your name in meetings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input
            id="display-name"
            aria-label="Your name in meetings"
            value={name ?? ""}
            onChange={(e) => setName(e.target.value)}
            placeholder="Priya"
          />
          <Button
            variant="outline"
            disabled={isLoading}
            onClick={() => void save()}
            className="shrink-0"
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Spell it the way your transcripts do — that is what action items are
          assigned to. Used for My tasks, and nothing else.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * What the bell is allowed to say.
 *
 * Switches, not a master off — a bell that can only be silenced entirely gets
 * silenced entirely the first time it says something useless, and then the
 * failed upload goes unseen too. The list comes from the server so adding a kind
 * is a backend change and the wording of the switch cannot drift from the
 * wording of the notification.
 */
function NotificationsCard() {
  const kinds = useGetNotificationKindsQuery();
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();

  const muted = React.useMemo(
    () => new Set(prefs.data?.mutedNotifications ?? []),
    [prefs.data?.mutedNotifications],
  );

  async function toggle(kind: string, on: boolean) {
    const next = new Set(muted);
    if (on) next.delete(kind);
    else next.add(kind);
    try {
      // The whole set every time: the page holds every switch on screen, and a
      // delta from a stale render is how two of them end up disagreeing.
      await update({ mutedNotifications: Array.from(next) }).unwrap();
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4 text-primary" /> Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          What shows up in the bell. None of these send email — that is the
          Emails tab.
        </p>
        {(kinds.data ?? []).map((k) => (
          <label
            key={k.kind}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
          >
            <span className="min-w-0">
              <span className="block text-sm">Tell me {k.setting}</span>
              {!k.mutable && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Always on — silence here would be indistinguishable from
                  nothing having happened.
                </span>
              )}
            </span>
            <input
              type="checkbox"
              checked={!muted.has(k.kind)}
              disabled={!k.mutable || isLoading}
              onChange={(e) => void toggle(k.kind, e.target.checked)}
              aria-label={`Tell me ${k.setting}`}
              className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] disabled:opacity-50"
            />
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

function BrowserCard() {
  const dispatch = useAppDispatch();
  const ui = useAppSelector((s) => s.ui);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">In this browser</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ToggleRow
          label="Show a desktop notification when a brief is ready"
          checked={ui.notifyProcessingDone}
          onChange={(v) => dispatch(setNotifyProcessingDone(v))}
        />
        <p className="text-xs text-muted-foreground">
          Separate from the bell above and stored locally, so it applies to this
          browser rather than to your account.
        </p>
      </CardContent>
    </Card>
  );
}
