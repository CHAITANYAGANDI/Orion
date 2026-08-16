"use client";

import * as React from "react";
import { toast } from "sonner";
import { ListChecks, Mail } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { setNotifyProcessingDone } from "@/lib/uiSlice";
import {
  useGetUsageQuery,
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Show a browser notification when a brief is ready"
            checked={ui.notifyProcessingDone}
            onChange={(v) => dispatch(setNotifyProcessingDone(v))}
          />
          <p className="text-xs text-muted-foreground">
            This one is stored locally in your browser.
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="font-medium">Delete account data</p>
            <p className="text-sm text-muted-foreground">Removes meetings, transcripts and action items.</p>
          </div>
          <Button
            variant="destructive"
            onClick={() =>
              toast.info("Per-meeting deletion is available from each meeting's page in this build.")
            }
          >
            Request deletion
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
