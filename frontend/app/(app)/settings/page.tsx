"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bell, ListChecks, Mail, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { setNotifyProcessingDone } from "@/lib/uiSlice";
import {
  useGetUsageQuery,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetNotificationKindsQuery,
} from "@/lib/api";
import { KnownSpeakersCard } from "@/components/known-speakers-card";
import { VocabularyCard } from "@/components/vocabulary-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  const { userId, mode } = useAuth();
  const usage = useGetUsageQuery();
  const dispatch = useAppDispatch();
  const ui = useAppSelector((s) => s.ui);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Profile, notifications and data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>User ID</Label>
            <Input value={userId} readOnly />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Auth mode:</span>
            <Badge variant="secondary">{mode}</Badge>
            {usage.data && <Badge>{usage.data.plan}</Badge>}
          </div>
        </CardContent>
      </Card>

      <RecapEmailCard />

      <ActionItemsCard />

      <VocabularyCard />

      <KnownSpeakersCard />

      <NotificationsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">In this browser</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Show a browser notification when a brief is ready"
            checked={ui.notifyProcessingDone}
            onChange={(v) => dispatch(setNotifyProcessingDone(v))}
          />
          <p className="text-xs text-muted-foreground">
            A desktop pop-up, separate from the bell above. Stored locally, so it
            applies to this browser rather than to your account.
          </p>
        </CardContent>
      </Card>

      {/* Not a second copy of the controls — a signpost to the page that owns
          them. Deleting an account is not a settings toggle, and it belongs
          beside the export that is the only thing standing between somebody and
          losing everything. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Privacy &amp; data
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            What Recallix holds, what is shared, how long it is kept, downloading
            all of it, and closing the account.
          </p>
          <Button variant="outline" asChild>
            <Link href="/privacy">Open privacy &amp; data</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The recap email preference.
 *
 * Server-side, unlike the browser notification toggle below it: the decision is
 * acted on by the worker callback long after the tab that set it has gone.
 */
function RecapEmailCard() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [address, setAddress] = React.useState<string | null>(null);

  // Only seed the input once, so typing isn't clobbered by a refetch.
  const loaded = prefs.data;
  React.useEffect(() => {
    if (loaded && address === null) setAddress(loaded.recapEmail ?? "");
  }, [loaded, address]);

  async function save(patch: { autoEmailRecap?: boolean; recapEmail?: string }) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(errorMessage(err));
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
          onChange={(v) => save({ autoEmailRecap: v })}
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
                onClick={() => save({ recapEmail: address ?? "" })}
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
          The recap is drafted from the meeting&apos;s summary and action items,
          the same as the draft on each meeting page. It is sent once per meeting.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Two settings that only make sense together.
 *
 * The name is what makes "My tasks" possible at all: action items are assigned
 * to whoever the transcript names, and nothing joins that to an account. The
 * digest is the only thing in Recallix that contacts you without you opening it,
 * and it is worth very little until it knows which of the tasks are yours.
 */
function ActionItemsCard() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [name, setName] = React.useState<string | null>(null);

  // Seeded once, so a refetch cannot clobber what is being typed.
  const loaded = prefs.data;
  React.useEffect(() => {
    if (loaded && name === null) setName(loaded.displayName ?? "");
  }, [loaded, name]);

  async function save(patch: { displayName?: string; taskReminders?: boolean }) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="h-4 w-4 text-primary" /> Action items
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="display-name">Your name in meetings</Label>
          <div className="flex gap-2">
            <Input
              id="display-name"
              value={name ?? ""}
              onChange={(e) => setName(e.target.value)}
              placeholder="Priya"
            />
            <Button
              variant="outline"
              disabled={isLoading}
              onClick={() => save({ displayName: name ?? "" })}
              className="shrink-0"
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Spell it the way your transcripts do — that is what tasks are
            assigned to. Used for My tasks, and nothing else.
          </p>
        </div>

        <ToggleRow
          label="Email me a daily digest of what is overdue or due soon"
          checked={prefs.data?.taskReminders ?? false}
          onChange={(v) => save({ taskReminders: v })}
        />
        <p className="text-xs text-muted-foreground">
          One message a morning, and none at all on a day when nothing is due.
          Goes to the same address as your recaps.
        </p>
      </CardContent>
    </Card>
  );
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return "Couldn't save that.";
}

/**
 * What the bell is allowed to say.
 *
 * <p>Switches, not a master off — a bell that can only be silenced entirely is
 * one that gets silenced entirely the first time it says something useless, and
 * then the failed upload goes unseen too.
 *
 * <p>The list of kinds comes from the server rather than being written here, so
 * adding one is a backend change and the wording of the switch cannot drift
 * from the wording of the notification. Failures have no switch at all: muting
 * them makes "nothing happened" and "something broke" the same silence.
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
      toast.error(errorMessage(err));
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
          What shows up in the bell. These stay in Recallix — none of them send email.
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
                  Always on — a failure you are not told about is a meeting that
                  looks like it is still running.
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

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[hsl(var(--primary))]"
      />
    </label>
  );
}
