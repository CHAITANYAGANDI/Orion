"use client";

/**
 * Emails — the only two things Recallix sends without being opened.
 *
 * Both off by default and both on this one tab, because the question somebody
 * comes here to answer is "what is this going to send me", and an answer split
 * across two pages is two answers.
 *
 * Server-side, unlike the browser toggle on General: the recap is decided by a
 * worker callback long after the tab that set it has gone, and the digest by a
 * scheduler at eight in the morning.
 */

import * as React from "react";
import { toast } from "sonner";
import { Mail, ListChecks } from "lucide-react";
import { useGetPreferencesQuery, useUpdatePreferencesMutation } from "@/lib/api";
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
          deadlines whether or not this is on — see Notifications under General.
        </p>
      </CardContent>
    </Card>
  );
}
