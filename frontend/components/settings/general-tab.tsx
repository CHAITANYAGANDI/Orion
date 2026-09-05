"use client";

/**
 * General — who you are, what is done with it, and the way out.
 *
 * Five things, in the order somebody needs them: the identity block, the
 * language your meetings are held in, what Reverie does and does not do with a
 * recording, how long it keeps one, and the button that ends the account.
 *
 * Every field here is read by something. Your name is matched against the owner
 * of every action item, which is the only thing that turns a list of promises
 * into "my tasks". Language is sent with each transcription job: detection is
 * good and not perfect, and a wrong guess on a short or bilingual recording is a
 * transcript in a language nobody spoke. Department and Role used to sit here
 * too and were read by nothing at all — a form that asks for facts it never uses
 * is one people fill in for nothing, so they are gone.
 *
 * Email and password are the two Reverie may not own. The address is shown and
 * never editable, by any kind of account: it is the credential, so every route
 * to changing it is a route to losing an account, and it is fixed once the
 * account is made. The password is never Reverie's either — there is no password
 * column, so the change is handed to the provider, and a development session
 * has no provider and therefore nothing to rotate.
 *
 * The last two sections are the ones that delete things, and they are on this
 * page rather than behind a tab of their own because there is no longer a tab of
 * their own. Both endpoints have existed and worked for months with nothing in
 * the interface able to reach them: retention could only be set, and an account
 * only closed, by calling the API by hand. A deletion schedule that runs every
 * night and cannot be seen from inside the product is the worst version of this
 * feature, so it is now visible.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Globe,
  Lightbulb,
  Mail,
  Loader2,
  Pencil,
  Trash2,
  UserCheck,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { identityPermissions } from "@/lib/identity-owner";
import {
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetLanguagesQuery,
  useGetPrivacyOverviewQuery,
  useUpdateRetentionMutation,
  useCloseAccountMutation,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingsError } from "@/components/settings/shared";
import { LEGAL_LINKS } from "@/lib/build-info";
import { cn } from "@/lib/utils";
import {
  Avatar,
  ProfileDialog,
  type ProfileForm,
  type ProfilePatch,
} from "@/components/settings/profile-dialog";
import {
  RETENTION_CHOICES,
  DELETE_PHRASE,
  confirmsDeletion,
  retentionLabel,
} from "@/lib/privacy";

export function GeneralTab() {
  return (
    <div className="space-y-1">
      <IdentityBlock />
      <LanguageRow />
      <TrainingSection />
      <EmailSection />
      <RetentionSection />
      <CloseAccountSection />
      <Footer />
    </div>
  );
}

/**
 * Name, photo, email and password.
 *
 * <p>Read-only until Edit is pressed. A settings page whose every field is an
 * input invites somebody to change one by accident while reading it, and this
 * block is read far more often than it is edited.
 */
function IdentityBlock() {
  const { userId, mode, profile } = useAuth();
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [editing, setEditing] = React.useState(false);

  /*
   * Two kinds of account, and until now this block could not tell them apart.
   * It asked whether the deployment used Clerk, which is true for a Google
   * sign-in and for an email-and-password sign-up alike -- so it offered a
   * password dialog to both, when only one of them has a password to rotate.
   * See lib/identity-owner.
   */
  const permissions = identityPermissions({
    mode,
    provider: profile.provider,
    hasPassword: profile.hasPassword,
  });

  // The provider's address is the real one under Clerk; Reverie's column is a
  // copy that can lag until the next sign-in.
  const name = prefs.data?.displayName || profile.name || "";
  const email = prefs.data?.email || profile.email || null;
  const passwordNote = permissions.password
    ? "Set here. Changing it signs out your other sessions."
    : permissions.owner === "external"
      ? `You sign in with ${permissions.ownerLabel}.`
      : "Development session — there is no password.";

  const initial: ProfileForm = {
    displayName: name,
    email: email ?? "",
    avatarUrl: prefs.data?.avatarUrl ?? "",
  };

  async function save(patch: ProfilePatch) {
    try {
      await update(patch).unwrap();
      setEditing(false);
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <div className="border-b py-6">
      <div className="flex items-start gap-4">
        <Avatar url={prefs.data?.avatarUrl} name={name || userId} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">
            {name || <span className="text-muted-foreground">No name yet</span>}
          </p>
          <p className="truncate text-sm">
            {email ? (
              <a href={`mailto:${email}`} className="text-primary underline-offset-2 hover:underline">
                {email}
              </a>
            ) : (
              <span className="text-muted-foreground">No email address yet</span>
            )}
          </p>
          {/* Dots, and a sentence saying whose password they are. Reverie
              never sees it: Clerk holds it, and a development session is
              identified by a header and has none at all. */}
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="tracking-[0.2em]">•••••••••</span>
            <span className="text-xs">{passwordNote}</span>
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          className="shrink-0 gap-1.5"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      </div>

      <ProfileDialog
        open={editing}
        initial={initial}
        permissions={permissions}
        saving={isLoading}
        onClose={() => setEditing(false)}
        onSave={(patch) => void save(patch)}
      />
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={120}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The language meetings are held in.
 *
 * <p>Auto-detect is the default and stays first, because it is the right answer
 * for anyone whose meetings are not all in one language. The list is served —
 * it is the eighteen languages transcription actually supports, and a picker
 * offering a nineteenth would be offering a transcript that cannot be made.
 */
function LanguageRow() {
  const prefs = useGetPreferencesQuery();
  const languages = useGetLanguagesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();

  async function choose(code: string) {
    try {
      await update({ defaultLanguage: code }).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <Row
      icon={<Globe className="h-4 w-4" />}
      title="Language"
      description="Default language for your future conversations"
      action={
        <select
          aria-label="Default language"
          disabled={isLoading}
          value={prefs.data?.defaultLanguage ?? ""}
          onChange={(e) => void choose(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">Detect automatically</option>
          {(languages.data ?? []).map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      }
    />
  );
}

/**
 * The section with nothing to switch.
 *
 * <p>Every competitor puts a toggle here, because they have something to ask
 * permission for. Reverie does not train models, so the honest version of this
 * section is a statement of who sees the data on the way to producing your
 * notes — and no switch, because a switch would imply there is a use to opt out
 * of.
 *
 * <p>It links down the page rather than across to a Security tab. That tab is
 * gone; what it used to promise — that you can see and delete what is held — is
 * now the next two sections.
 */
function TrainingSection() {
  return (
    <section aria-labelledby="training-heading" className="space-y-1 pt-6">
      <h2 id="training-heading" className="flex items-center gap-2 text-title-3 font-headline text-ink">
        <Lightbulb className="h-4 w-4 text-ink-3" /> Feedback and training
      </h2>
      <div className="space-y-2 border-b border-line py-4 text-callout text-ink-3">
        <p>
          <strong className="text-foreground">
            Reverie does not train on your meetings.
          </strong>{" "}
          Your recordings, transcripts and notes are not used to improve any
          model, are not reviewed by people here, and are not pooled with anybody
          else&apos;s.
        </p>
        <p>
          Producing your notes does mean sending the audio to a speech-to-text
          provider and the transcript to a language model. There is no switch on
          this section because there is nothing to switch off — a toggle here
          would imply a use that does not happen.
        </p>
        {/* Said here because it changed, and because it is the one part of
            the path that is not "after you press Save". Somebody reading this
            page is entitled to know that a meeting is being sent somewhere
            while it is still happening, not only afterwards. */}
        <p>
          <strong className="text-foreground">
            While you are recording, audio is streamed to that same speech-to-text
            provider as you speak
          </strong>{" "}
          — that is what produces the live text on the recording page. It goes
          from your browser to the provider directly, so the words appear without
          waiting for the meeting to end. The recording itself is still
          transcribed in full afterwards, and that fuller transcript is the one
          that is kept.
        </p>
        <p>
          How long any of it stays is <a href="#data" className="text-primary underline-offset-2 hover:underline">yours to set below</a>,
          and you can delete the whole account from the same place.
        </p>
      </div>
    </section>
  );
}

/**
 * What Reverie will write to you about.
 *
 * <h2>Why this exists at all, given V56 deleted the tab it used to be</h2>
 *
 * <p>V56 removed every email and said why: the switches had no UI to reach
 * them, so nothing was going out and nobody could have turned anything on. It
 * also deleted the four messages, and it was right about those too — they
 * reported things the reader could see by opening the app.
 *
 * <p>Five messages came back that pass a different test: they reach somebody
 * who is <em>not</em> in Reverie, about something they cannot see from outside
 * it, while there is still something to do about it. Every one of them is off
 * until it is switched on here, which is the half V56 was missing.
 *
 * <h2>What is not on this list</h2>
 *
 * <p>Two messages have no switch and the page says so rather than hiding it:
 * running out of the allowance, and the account being closed. Neither is a
 * notification about the contents of an account. The second is the sharper
 * case — closing an account deletes the row these very switches live on, so by
 * the time it is sent there is nothing left to consult and no bell left to
 * ring.
 *
 * <p>Each switch saves on its own. A section of six toggles behind one Save
 * button is a section where flipping one thing and leaving loses it.
 */
function EmailSection() {
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();

  async function set(field: EmailSwitch, value: boolean) {
    try {
      await update({ [field]: value }).unwrap();
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <section id="email" aria-labelledby="email-heading" className="space-y-1 pt-6">
      <h2 id="email-heading" className="flex items-center gap-2 text-title-3 font-headline text-ink">
        <Mail className="h-4 w-4 text-ink-3" /> Email notifications
      </h2>
      <div className="space-y-3 border-b border-line py-4">
        <p className="text-callout text-ink-3">
          All off unless you turn them on. Reverie does not email you about
          things you can see by opening it.
        </p>

        {prefs.isLoading ? (
          <div className="space-y-2" aria-hidden>
            {EMAIL_SWITCHES.map((s) => (
              <div key={s.field} className="h-[58px] animate-pulse rounded-md border bg-muted/40" />
            ))}
          </div>
        ) : prefs.isError || !prefs.data ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn&apos;t load your email settings. Reload the page to try again.
          </p>
        ) : (
          <div className="space-y-2">
            {EMAIL_SWITCHES.map((row) => (
              <label
                key={row.field}
                className="flex cursor-pointer items-start justify-between gap-3 rounded-md border p-3"
              >
                <span className="space-y-0.5">
                  <span className="block text-sm">{row.label}</span>
                  <span className="block text-xs text-muted-foreground">{row.detail}</span>
                </span>
                <input
                  type="checkbox"
                  checked={prefs.data![row.field]}
                  disabled={isLoading}
                  onChange={(e) => void set(row.field, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                />
              </label>
            ))}
          </div>
        )}

        {/* Said rather than hidden. A switch somebody cannot find reads as a
            message they cannot stop. */}
        <p className="text-xs text-muted-foreground">
          Two messages have no switch: running out of transcription minutes, and
          your account being closed and its data deleted. Neither is about the
          contents of your account, and the second is sent after everything —
          including these settings — has been deleted.
        </p>
      </div>
    </section>
  );
}

type EmailSwitch =
  | "retentionWarningEmail"
  | "retentionAppliedEmail"
  | "taskReminderEmail"
  | "notesReadyEmail"
  | "allowanceEmail";

/**
 * In the order they matter, which is not the order they were built.
 *
 * <p>The warning first: it is the only one that arrives while there is still
 * something to do. Everything below it reports.
 */
const EMAIL_SWITCHES: { field: EmailSwitch; label: string; detail: string }[] = [
  {
    field: "retentionWarningEmail",
    label: "Before retention deletes something",
    detail: "A week's notice, and only when something is actually due.",
  },
  {
    field: "retentionAppliedEmail",
    label: "After retention deletes something",
    detail: "One message for the night's work, never one per meeting.",
  },
  {
    field: "taskReminderEmail",
    label: "Action items due tomorrow",
    detail: "One digest each morning, including anything overdue. Nothing when the list is empty.",
  },
  {
    field: "notesReadyEmail",
    label: "Notes ready for a long recording",
    detail: "Only above fifteen minutes — a short one is finished before you have left the page.",
  },
  {
    field: "allowanceEmail",
    label: "When your transcription minutes are nearly gone",
    detail: "Once, at 85%. There is nothing to buy; it is so you can choose what to record.",
  },
];

/**
 * How long a recording is kept, and how long a meeting is.
 *
 * <p>Two dials because "how long do you keep the recording of my voice" and
 * "how long do you keep the notes" are asked by different people. Everyone who
 * was in the room can ask the first; only the account holder cares about the
 * second. "A week for the recording, forever for the notes" is a coherent and
 * common answer, and one number cannot say it.
 *
 * <p><strong>Both dials are sent on every change.</strong> The API reads a null
 * as "keep forever" rather than "leave this one alone" — the opposite of every
 * other patch in it — because the two constrain each other and a partial update
 * from a stale render is how somebody ends up with a rule they did not set.
 *
 * <p>The choices that would break that constraint are disabled rather than
 * offered and refused. The server's message is a good one, but a control that
 * exists to be clicked and then rejected is a control that wasted a click.
 */
function RetentionSection() {
  const overview = useGetPrivacyOverviewQuery();
  const [update, { isLoading }] = useUpdateRetentionMutation();
  const policy = overview.data?.retention;

  async function choose(which: "audio" | "meeting", days: number | null) {
    if (!policy) return;
    try {
      await update({
        audioDays: which === "audio" ? days : policy.audioDays,
        meetingDays: which === "meeting" ? days : policy.meetingDays,
      }).unwrap();
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <section id="data" aria-labelledby="retention-heading" className="space-y-1 pt-6">
      <h2 id="retention-heading" className="flex items-center gap-2 text-title-3 font-headline text-ink">
        <Clock className="h-4 w-4 text-muted-foreground" /> How long things are kept
      </h2>
      <p className="pb-2 text-sm text-muted-foreground">
        Nothing is deleted on a schedule until you choose one here. Both start at
        Never.
      </p>

      <div className="space-y-6 border-b py-4">
        {overview.isLoading || !policy ? (
          <p className="text-sm text-muted-foreground">
            {overview.isLoading
              ? "Loading your policy…"
              : "Couldn't load your retention policy. Reload the page to try again."}
          </p>
        ) : (
          <>
            <Dial
              label="Delete the recording"
              hint="The audio goes. The transcript, summary and action items stay."
              value={policy.audioDays}
              disabled={isLoading}
              // Refused by the server, because a recording rule that the meeting
              // rule deletes out from under is a rule that never runs.
              blocked={(days) =>
                policy.meetingDays !== null && days !== null && days > policy.meetingDays
                  ? "Longer than the whole meeting is kept."
                  : null
              }
              onChoose={(days) => void choose("audio", days)}
              dueNow={policy.recordingsDueNow}
              dueNoun="recording"
            />
            <Dial
              label="Delete the whole meeting"
              hint="Everything about it: the recording, the transcript, the notes and its action items."
              value={policy.meetingDays}
              disabled={isLoading}
              blocked={(days) =>
                policy.audioDays !== null && days !== null && days < policy.audioDays
                  ? "Shorter than the recording is kept."
                  : null
              }
              onChoose={(days) => void choose("meeting", days)}
              dueNow={policy.meetingsDueNow}
              dueNoun="meeting"
            />
            <p className="text-xs text-muted-foreground">
              Age is counted from when a meeting was created, not from when you
              last opened it — otherwise the recording of a sensitive
              conversation survives longest precisely because people keep going
              back to it. Reverie checks once a day and tells you what it took.
              Deletion is immediate and cannot be undone.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * One retention window, as three buttons.
 *
 * <p>Buttons rather than a select. There are three options and the current one
 * is the answer to a question somebody is uneasy about — it should be readable
 * without opening anything.
 */
function Dial({
  label,
  hint,
  value,
  disabled,
  blocked,
  onChoose,
  dueNow,
  dueNoun,
}: {
  label: string;
  hint: string;
  value: number | null;
  disabled: boolean;
  blocked: (days: number | null) => string | null;
  onChoose: (days: number | null) => void;
  dueNow: number;
  dueNoun: string;
}) {
  const offList = !RETENTION_CHOICES.some((c) => c.days === value);

  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {RETENTION_CHOICES.map((choice) => {
          const reason = blocked(choice.days);
          const off = disabled || reason !== null;
          return (
            <button
              key={String(choice.days)}
              type="button"
              disabled={off}
              title={reason ?? undefined}
              aria-pressed={value === choice.days}
              onClick={() => onChoose(choice.days)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                value === choice.days
                  ? "border-primary bg-primary/10 text-primary"
                  : "hover:bg-accent",
                off && "cursor-not-allowed opacity-50",
              )}
            >
              {choice.label}
            </button>
          );
        })}
      </div>

      {/* A window set through the API, or left over from a longer list. Named
          rather than drawn as none of the three, which would read as Never. */}
      {offList && (
        <p className="mt-2 text-xs text-muted-foreground">
          Currently {retentionLabel(value).toLowerCase()}, which is not one of
          these. Choosing one replaces it.
        </p>
      )}

      {dueNow > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This deletes {dueNow} {dueNoun}
          {dueNow === 1 ? "" : "s"} you already have, at the next daily pass.
        </p>
      )}
    </div>
  );
}

/**
 * The end of the account.
 *
 * <p>Closed rather than hidden behind a support request, and it says the size of
 * what goes first, because the number is the warning: "deletes 91 meetings" is
 * read and "this is permanent" is not.
 *
 * <p>The phrase is checked here so the button can be disabled and again by the
 * server so a client that skipped the check cannot delete an account with an
 * empty body. The point is that it cannot be produced by a stray click.
 */
function CloseAccountSection() {
  const { signOut } = useAuth();
  const [close, { isLoading }] = useCloseAccountMutation();
  const [typed, setTyped] = React.useState("");
  const [open, setOpen] = React.useState(false);

  async function onClose() {
    try {
      const result = await close({ confirm: typed }).unwrap();
      toast.success(
        `Deleted ${result.meetings} meeting${result.meetings === 1 ? "" : "s"} and ` +
          `${result.storedObjects} recording${result.storedObjects === 1 ? "" : "s"}.`,
      );
      setOpen(false);
      setTyped("");
      signOut?.();
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  return (
    <section aria-labelledby="close-heading" className="space-y-1 pt-6">
      <h2
        id="close-heading"
        className="flex items-center gap-2 text-lg font-semibold text-destructive"
      >
        <Trash2 className="h-4 w-4" /> Delete this account
      </h2>

      <div className="space-y-3 border-b py-4">
        <p className="text-sm text-muted-foreground">
          Deletes everything,{" "}
          <strong className="text-foreground">permanently</strong>. Export
          anything you want to keep first.
        </p>

        {open ? (
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <label className="block text-sm" htmlFor="confirm-delete">
              Type <strong>{DELETE_PHRASE}</strong> to confirm.
            </label>
            <Input
              id="confirm-delete"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={DELETE_PHRASE}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setTyped("");
                }}
              >
                Keep my account
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!confirmsDeletion(typed) || isLoading}
                onClick={() => void onClose()}
              >
                {isLoading && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Delete everything
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        )}
      </div>
    </section>
  );
}

function Row({
  icon,
  title,
  description,
  action,
  bare,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
  bare?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", !bare && "border-b py-4")}>
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/**
 * The documents that govern this, where there are any.
 *
 * <h2>What used to be here</h2>
 *
 * <p>A build line — "Version 0.0.0 — dev build" — and a link reading "How long
 * Reverie keeps what is yours". Both are gone.
 *
 * <p>The build line was written for a bug report that could be traced to a
 * commit, and in a deployment built without one it says "0.0.0 — dev build",
 * which traces to nothing and reads as unfinished software to anybody who is
 * not the person who built it. A version that cannot identify a build is not
 * worth the line it costs.
 *
 * <p>The link went to <code>#data</code>, which is the retention section on
 * this same page, a few hundred pixels away and reachable by scrolling. A
 * footer link to the middle of the page you are already on is furniture.
 *
 * <p>What is left appears only when somebody has supplied the URLs. Reverie ships
 * no terms of service or privacy policy of its own — those are documents
 * somebody has to write and be bound by — and with neither set this renders
 * nothing at all rather than an empty strip of padding.
 */
function Footer() {
  if (LEGAL_LINKS.length === 0) return null;
  return (
    <div className="space-y-1 pt-8 text-center text-xs text-muted-foreground">
      <p>
        By using Reverie you agree to the{" "}
        {LEGAL_LINKS.map((link, i) => (
          <React.Fragment key={link.href}>
            {i > 0 && " and "}
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {link.label}
            </a>
          </React.Fragment>
        ))}
        .
      </p>
    </div>
  );
}
