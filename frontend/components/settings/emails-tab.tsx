"use client";

/**
 * Email Settings.
 *
 * One list of the things Recallix will send you without being opened, a master
 * switch over all of it, and then the bell — which is the same question asked of
 * a different channel and belongs beside it rather than a tab away.
 *
 * The list is short because the product is honest about what it can observe.
 * Every competitor's version of this page has rows for comments, highlights and
 * "a conversation was shared with me", and all three need a second person:
 * Recallix has one account per workspace, so the only party who could comment on
 * your notes or highlight your transcript is you, and a product that emails you
 * about your own actions is a product nobody reads the email from. The same goes
 * for anything scheduled — there is no calendar to read and no bot to send, so
 * a reminder that a meeting is "ready to be recorded" could never fire. Those
 * are named at the bottom rather than left out, because their absence is the
 * surprising part.
 *
 * The master leaves the switches underneath it alone. Somebody silencing email
 * for a fortnight expects to find their choices where they left them, and a
 * master that rewrote them would make that a one-way door.
 */

import * as React from "react";
import { toast } from "sonner";
import { Mail, Bell, Ban } from "lucide-react";
import {
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetNotificationKindsQuery,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingsError } from "@/components/settings/shared";

export function EmailsTab() {
  return (
    <div className="space-y-10">
      <EmailSettings />
      <NeverSent />
      <NotificationsCard />
    </div>
  );
}

/**
 * One row: what it is, when it fires, and the switch.
 *
 * The description is not decoration. "Meeting summary" alone does not say
 * whether importing forty files produces forty emails, and that is the only
 * thing anybody actually wants to know before turning it on.
 */
function EmailRow({
  title,
  body,
  checked,
  disabled = false,
  onChange,
  children,
}: {
  title: string;
  body: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b py-4 last:border-b-0">
      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block font-medium">{title}</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">{body}</span>
        </span>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={title}
          className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))] disabled:opacity-40"
        />
      </label>
      {children}
    </div>
  );
}

function EmailSettings() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [address, setAddress] = React.useState<string | null>(null);

  // Only seed the input once, so typing is not clobbered by a refetch.
  const loaded = prefs.data;
  React.useEffect(() => {
    if (loaded && address === null) setAddress(loaded.recapEmail ?? "");
  }, [loaded, address]);

  async function save(patch: Record<string, unknown>) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  const p = prefs.data;
  // Everything below the master is greyed while it is off — the switches keep
  // their values, and the page has to show that they are held rather than lost.
  const off = p ? !p.emailsEnabled : false;
  const destination = p?.effectiveRecapEmail;

  return (
    <section aria-labelledby="emails-heading" className="space-y-1">
      <h2 id="emails-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Mail className="h-4 w-4 text-muted-foreground" /> Email Settings
      </h2>
      <p className="pb-2 text-sm text-muted-foreground">
        What Recallix sends you without being opened. Every one of these is off
        until you turn it on, and each can be changed at any time.
      </p>

      <div className="border-b py-4">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="text-base font-semibold">All emails</span>
          <input
            type="checkbox"
            checked={p?.emailsEnabled ?? true}
            onChange={(e) => void save({ emailsEnabled: e.target.checked })}
            aria-label="All emails"
            className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
          />
        </label>
        <p className="mt-1 text-sm text-muted-foreground">
          {off
            ? "Nothing is being emailed. Your choices below are kept and come back exactly as they are."
            : "The master switch. Turning it off silences everything below without forgetting any of it."}
        </p>
      </div>

      <EmailRow
        title="Meeting summary"
        body="A summary and its action items are ready, for a meeting you recorded here."
        checked={p?.autoEmailRecap ?? false}
        disabled={off}
        onChange={(v) => void save({ autoEmailRecap: v })}
      />

      <EmailRow
        title="Imported conversation"
        body="A file or link you imported has finished processing. Separate from the row above because importing an archive of sixty files should not mean sixty emails."
        checked={p?.recapForImports ?? false}
        disabled={off}
        onChange={(v) => void save({ recapForImports: v })}
      />

      <EmailRow
        title="Deadline digest"
        body="One message listing what is overdue or due soon. Silent on a day when nothing is."
        checked={p?.taskReminders ?? false}
        disabled={off}
        onChange={(v) => void save({ taskReminders: v })}
      >
        {p?.taskReminders && (
          <div className="mt-3 flex items-center justify-between gap-4 pl-0">
            <span className="text-sm text-muted-foreground">How often</span>
            <select
              aria-label="How often"
              disabled={off}
              value={p.digestWeekly ? "weekly" : "daily"}
              onChange={(e) => void save({ digestWeekly: e.target.value === "weekly" })}
              className="h-9 shrink-0 rounded-md border bg-background px-3 text-sm disabled:opacity-40"
            >
              <option value="daily">Every morning</option>
              <option value="weekly">Mondays</option>
            </select>
          </div>
        )}
      </EmailRow>

      <EmailRow
        title="Shared link opened"
        body="Somebody outside opened a link you published. At most one email a day per link, however many times it is opened."
        checked={p?.shareOpenedEmail ?? false}
        disabled={off}
        onChange={(v) => void save({ shareOpenedEmail: v })}
      />

      <div className="py-4">
        <Label htmlFor="recap-email">Send all of it to</Label>
        <div className="mt-2 flex gap-2">
          <Input
            id="recap-email"
            type="email"
            value={address ?? ""}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={p?.effectiveRecapEmail ?? "you@example.com"}
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
        <p className="mt-2 text-xs text-muted-foreground">
          {destination
            ? `Everything above goes to ${destination}.`
            : "No address on file yet — add one above, or these have nowhere to go."}{" "}
          Leave it blank to use your account email.
        </p>
      </div>
    </section>
  );
}

/**
 * The rows a reader expects to find and will not.
 *
 * Named rather than omitted. Somebody who has used Otter arrives looking for
 * "Comments" and "Highlights", and finding neither reads as an unfinished
 * settings page rather than as a product that genuinely has nobody else in it.
 */
function NeverSent() {
  const absent: { title: string; body: string }[] = [
    {
      title: "Anything about a live or scheduled meeting",
      body: "Recallix has no meeting bot and does not read your calendar, so there is no event to announce and nothing that could be 'ready to be recorded'.",
    },
    {
      title: "Comments and highlights",
      body: "Both exist, and both are yours. With one account per workspace the only person who can comment on a note or highlight a transcript is you, and Recallix will not email you about something you just did.",
    },
    {
      title: "A conversation shared with you",
      body: "Sharing here goes outward — you publish a link. Nobody can share into your account, so the closest real event is somebody opening a link of yours, which is the switch above.",
    },
  ];

  return (
    <section aria-labelledby="never-heading" className="space-y-3">
      <h2 id="never-heading" className="text-lg font-semibold">
        What Recallix will never email you
      </h2>
      <Card>
        <CardContent className="space-y-4 pt-6">
          {absent.map((item) => (
            <div key={item.title} className="flex items-start gap-3 text-sm">
              <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="block font-medium">{item.title}</span>
                <span className="block text-muted-foreground">{item.body}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
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
          What shows up in the bell. These are a separate channel and the switch
          above does not govern them — silencing your inbox should not silence
          the failed upload waiting in the app.
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
