"use client";

/**
 * Email Settings.
 *
 * Seven messages under one select-all, and nothing else.
 *
 * <p><strong>Every row here sends something.</strong> The list is modelled on
 * what the category leaders offer, and the temptation with a list like that is
 * to render all of it and wire half. Recallix does not have a meeting bot or a
 * calendar, so "a calendar event recording has started" and "a scheduled event
 * is ready to be recorded" have no counterpart to fire them; and with one
 * account per workspace there is no second person to share a conversation in,
 * comment on it or highlight it. Rather than ship dead switches, each row is
 * wired to the nearest event Recallix genuinely has and described by what it
 * will actually do:
 *
 * - Conversation shared — outward, not inward. Nobody can share into this
 *   account, so the genuine other-party event is somebody opening a link you
 *   published.
 * - Weekly digest and Event reminder — the Monday review and the morning
 *   deadline mail. One setting with a cadence dropdown until V43, which made
 *   them exclusive; they are two messages and people want both.
 * - Comments and Highlights — your own, at most one message a day each. Not a
 *   report of a click back to the person who made it, but the evening reminder
 *   that this morning's transcript has notes in it.
 *
 * The descriptions are Recallix's rather than the ones on the screenshot this
 * list came from, because a row that promises a calendar and delivers a browser
 * tab is worse than a row that says what it does.
 *
 * <p>There was an eighth, "Live meeting", removed in V44 along with its column.
 * It fired on a recording starting, which is not the same event: the row it was
 * copied from means a bot joined a calendar invitation without you, and
 * Recallix records from a tab somebody opened on purpose.
 *
 * <p><strong>"All emails" is a select-all, not a gate.</strong> It reads as the
 * state of the seven rows — ticked when all are on, indeterminate when some
 * are — and writes all seven when clicked. It used to be a master that silenced
 * the rows while remembering them, which is a defensible design and not the one
 * the checkbox looks like: a tickbox above a list, unticked, with three ticked
 * rows underneath it reads as broken rather than as subtle.
 *
 * <p>`emailsEnabled` still exists as the server-side gate every sender checks
 * first, and it now simply moves with the select-all. Turning any single row on
 * re-opens it, so no combination reachable from this page can leave a ticked
 * row that sends nothing.
 *
 * <p><strong>Three things this page used to do and no longer does.</strong>
 * Removed on request; the capability behind each is untouched and still
 * reachable through the API, so putting a card back is a UI change rather than
 * a rebuild.
 *
 * <p><em>The recap address.</em> `PATCH /preferences` still accepts
 * `recapEmail`, and `effectiveRecapEmail` still falls back to the address the
 * sign-in provider gave us. Nothing in the app sets the override now, so mail
 * goes to the account email or nowhere — and a dev session has no provider and
 * therefore no address at all, which means every switch above is a switch with
 * no destination and the page no longer says so.
 *
 * <p><em>The bell's switches.</em> `GET /notifications/kinds` and the
 * `mutedNotifications` field on `PATCH /preferences` both still work and now
 * have no caller. Every kind is therefore on, permanently, since nothing can
 * write a mute.
 *
 * <p><em>The line that said where mail was going.</em> Worth knowing it is
 * gone: eight opt-in switches with no visible destination fail silently when
 * there is no address on file.
 */

import { toast } from "sonner";
import { Mail } from "lucide-react";
import { useGetPreferencesQuery, useUpdatePreferencesMutation } from "@/lib/api";
import type { PreferencesResponse, PreferencesUpdateRequest } from "@/lib/types";
import { settingsError } from "@/components/settings/shared";

export function EmailsTab() {
  return <EmailSettings />;
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
  onChange,
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange: (value: boolean) => void;
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
          onChange={(e) => onChange(e.target.checked)}
          aria-label={title}
          className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
        />
      </label>
    </div>
  );
}

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];

/**
 * A field that is a boolean on both sides of the wire.
 *
 * Derived rather than written out, so a mistyped field name below is a
 * compile error rather than a switch that reads as broken: `checked` would
 * fall back to false on every render and the save would be silently dropped by
 * the server, which looks exactly like a switch that will not stay on.
 */
type EmailSwitch = BooleanKeys<PreferencesResponse> & BooleanKeys<PreferencesUpdateRequest>;

/**
 * The rows, in the order they are listed.
 *
 * <p>Data rather than eight near-identical blocks of JSX, so the order on
 * screen, the field each one writes and the sentence describing it are visible
 * together — which is where a crossed wire would otherwise hide.
 */
const ROWS: { field: EmailSwitch; title: string; body: string }[] = [
  {
    field: "autoEmailRecap",
    title: "Meeting summary",
    body: "A summary and its action items are ready, for a meeting you recorded here.",
  },
  {
    field: "recapForImports",
    title: "Imported conversation",
    body: "A file or link you imported has finished processing. Separate from the row above because importing an archive of sixty files should not mean sixty emails.",
  },
  {
    field: "shareOpenedEmail",
    title: "Conversation shared",
    body: "Somebody outside opened a conversation you shared. Sharing here goes outward — nobody can share into your account — so this is the arrival, not the invitation. At most one a day per link.",
  },
  {
    field: "weeklyDigest",
    title: "Weekly digest",
    body: "Monday morning: your action items for the week ahead, and anything already late. Silent on a Monday with nothing outstanding.",
  },
  {
    field: "taskReminders",
    title: "Event reminder",
    body: "Every morning: what is due today or in the next few days. Silent on a day when nothing is. On a Monday you get the digest above instead, not both.",
  },
  {
    field: "commentEmail",
    title: "Comments",
    body: "A comment was added to an action item. At most one a day, so working through a meeting's tasks is one message rather than fifteen.",
  },
  {
    field: "highlightEmail",
    title: "Highlights",
    body: "A passage was highlighted in a conversation. At most one a day, for the same reason.",
  },
];

function EmailSettings() {
  const prefs = useGetPreferencesQuery();
  const [update] = useUpdatePreferencesMutation();

  async function save(patch: PreferencesUpdateRequest) {
    try {
      await update(patch).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  const p = prefs.data;
  const on = ROWS.filter((row) => p?.[row.field]).length;
  const allOn = on === ROWS.length;
  const someOn = on > 0;

  /**
   * The master, as a select-all.
   *
   * <p>One patch carrying every field rather than a loop of one-field patches:
   * seven requests would each pop their own "Saved." toast, and a failure
   * halfway through would leave the page showing four rows on and three off
   * with nothing to say why.
   *
   * <p>`emailsEnabled` moves with it. It is the server-side gate every sender
   * checks first, so leaving it false while switching the rows on would mean a
   * page full of ticks and no mail.
   */
  function setAll(value: boolean) {
    const patch: PreferencesUpdateRequest = { emailsEnabled: value };
    for (const row of ROWS) {
      (patch as Record<string, boolean>)[row.field] = value;
    }
    return save(patch);
  }

  /**
   * One row.
   *
   * <p>Turning any row on re-opens the gate. Without that, unchecking the
   * master and then picking a single row back out of the list would tick the
   * box and send nothing — the switch would look broken rather than blocked.
   */
  function setOne(field: EmailSwitch, value: boolean) {
    const patch = { [field]: value } as PreferencesUpdateRequest;
    if (value) patch.emailsEnabled = true;
    return save(patch);
  }

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
            checked={allOn}
            // A callback ref rather than state: `indeterminate` is a DOM
            // property with no HTML attribute, so React cannot set it from
            // JSX. This runs on every render, which is exactly when the count
            // it depends on can have changed.
            ref={(el) => {
              if (el) el.indeterminate = someOn && !allOn;
            }}
            onChange={(e) => void setAll(e.target.checked)}
            aria-label="All emails"
            className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
          />
        </label>
        <p className="mt-1 text-sm text-muted-foreground">
          {allOn
            ? "Everything below is on. Unticking this turns all of them off."
            : someOn
              ? `${on} of ${ROWS.length} are on. Ticking this turns on the rest.`
              : "Nothing is being emailed. Ticking this turns on everything below."}
        </p>
      </div>

      {ROWS.map((row) => (
        <EmailRow
          key={row.field}
          title={row.title}
          body={row.body}
          checked={p?.[row.field] ?? false}
          onChange={(v) => void setOne(row.field, v)}
        />
      ))}
    </section>
  );
}
