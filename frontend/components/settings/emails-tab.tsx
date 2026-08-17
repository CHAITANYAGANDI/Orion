"use client";

/**
 * What Recallix sends you, by channel.
 *
 * The two emails first — the only things it sends without being opened — and
 * then the bell, which is the same question asked of a different channel. They
 * are together because "what is this going to tell me, and where" is one
 * question, and an answer split across two tabs is two answers.
 *
 * All of it server-side, unlike the browser toggle on General: the recap is
 * decided by a worker callback long after the tab that set it has gone, the
 * digest by a scheduler at eight in the morning, and the bell by whatever
 * happened while nobody was looking.
 */

import * as React from "react";
import { toast } from "sonner";
import { Mail, ListChecks, Bell } from "lucide-react";
import {
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetNotificationKindsQuery,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingsError, ToggleRow } from "@/components/settings/shared";

export function EmailsTab() {
  return (
    <div className="space-y-6">
      <RecapCard />
      <DigestCard />
      <NotificationsCard />
    </div>
  );
}

function RecapCard() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [address, setAddress] = React.useState<string | null>(null);

  // Only seed the input once, so typing is not clobbered by a refetch.
  const loaded = prefs.data;
  React.useEffect(() => {
    if (loaded && address === null) setAddress(loaded.recapEmail ?? "");
  }, [loaded, address]);

  async function save(patch: { autoEmailRecap?: boolean; recapEmail?: string }) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  const enabled = prefs.data?.autoEmailRecap ?? false;
  const destination = prefs.data?.effectiveRecapEmail;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" /> Recap email
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ToggleRow
          label="Email me the recap when a meeting finishes processing"
          checked={enabled}
          onChange={(v) => void save({ autoEmailRecap: v })}
        />

        {enabled && (
          <div className="grid gap-2">
            <Label htmlFor="recap-email">Send to</Label>
            <div className="flex gap-2">
              <Input
                id="recap-email"
                type="email"
                value={address ?? ""}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={prefs.data?.effectiveRecapEmail ?? "you@example.com"}
              />
              <Button
                variant="outline"
                disabled={isLoading}
                onClick={() => void save({ recapEmail: address ?? "" })}
                className="shrink-0"
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {destination
                ? `Recaps go to ${destination}.`
                : "No address on file yet — add one above."}{" "}
              Leave blank to use your account email.
            </p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Drafted from the meeting&apos;s summary and action items, the same as
          the draft on each meeting page. Sent once per meeting.
        </p>
      </CardContent>
    </Card>
  );
}

function DigestCard() {
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  async function save(taskReminders: boolean) {
    try {
      await update({ taskReminders }).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="h-4 w-4 text-primary" /> Deadline digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ToggleRow
          label="Email me a daily digest of what is overdue or due soon"
          checked={prefs.data?.taskReminders ?? false}
          onChange={(v) => void save(v)}
        />
        <p className="text-xs text-muted-foreground">
          One message a morning, and none at all on a day when nothing is due.
          Goes to the same address as your recaps. The bell shows the same
          deadlines whether or not this is on — see below.
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
 * failed upload goes unseen too. The list comes from the server, so adding a
 * kind is a backend change and the wording of the switch cannot drift from the
 * wording of the notification it governs.
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
          <Bell className="h-4 w-4 text-primary" /> In-app notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          What shows up in the bell. None of these send email — the two above are
          the only things that do.
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
