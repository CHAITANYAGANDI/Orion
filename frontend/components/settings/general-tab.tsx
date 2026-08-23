"use client";

/**
 * General — who you are, how you are transcribed, and the way out.
 *
 * Five things, in the order somebody needs them: the identity block, the
 * language your meetings are held in, the words Recallix keeps getting wrong,
 * and what this browser stores.
 *
 * Two of the fields here are descriptive and two are not, and the difference is
 * worth stating. Department and Role are yours to record and nothing reads them
 * — there are no teams for a department to route to. Your name is matched
 * against the owner of every action item, which is the only thing that turns a
 * list of promises into "my tasks". Language is sent with each transcription
 * job: detection is good and not perfect, and a wrong guess on a short or
 * bilingual recording is a transcript in a language nobody spoke.
 *
 * Email and password are shown and not editable, because neither is Recallix's
 * to change — they belong to the sign-in provider, and a development session has
 * no provider at all.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  Globe,
  Loader2,
  Pencil,
  ShieldAlert,
  SpellCheck,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import {
  useGetPreferencesQuery,
  useUpdatePreferencesMutation,
  useGetLanguagesQuery,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingsError } from "@/components/settings/shared";
import { BUILD_LINE, LEGAL_LINKS } from "@/lib/build-info";
import { cn } from "@/lib/utils";
import { VocabularyCard } from "@/components/vocabulary-card";
import { KnownSpeakersCard } from "@/components/known-speakers-card";

export function GeneralTab() {
  return (
    <div className="space-y-1">
      <IdentityBlock />
      <LanguageRow />
      <TranscriptionSection />
      <Footer />
    </div>
  );
}

/**
 * Name, email, password, department, role.
 *
 * <p>Read-only until Edit is pressed. A settings page whose every field is an
 * input invites somebody to change one by accident while reading it, and this
 * block is read far more often than it is edited.
 */
function IdentityBlock() {
  const { userId, mode } = useAuth();
  const prefs = useGetPreferencesQuery();
  const [update, { isLoading }] = useUpdatePreferencesMutation();
  const [editing, setEditing] = React.useState(false);

  const [form, setForm] = React.useState({ displayName: "", department: "", jobRole: "" });

  function open() {
    setForm({
      displayName: prefs.data?.displayName ?? "",
      department: prefs.data?.department ?? "",
      jobRole: prefs.data?.jobRole ?? "",
    });
    setEditing(true);
  }

  async function save() {
    try {
      await update(form).unwrap();
      setEditing(false);
      toast.success("Saved.");
    } catch (err) {
      toast.error(settingsError(err));
    }
  }

  const name = prefs.data?.displayName;
  const email = prefs.data?.email;
  const initials = (name || userId || "me").slice(0, 2).toUpperCase();

  return (
    <div className="border-b py-6">
      <div className="flex items-start gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
          {initials}
        </span>

        {editing ? (
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            <Field
              id="full-name"
              label="Full Name"
              value={form.displayName}
              onChange={(v) => setForm({ ...form, displayName: v })}
              placeholder="Priya Raman"
              hint="Spell it the way your transcripts do — that is what action items are matched against."
            />
            <Field
              id="department"
              label="Department"
              value={form.department}
              onChange={(v) => setForm({ ...form, department: v })}
              placeholder="IT"
            />
            <Field
              id="job-role"
              label="Role"
              value={form.jobRole}
              onChange={(v) => setForm({ ...form, jobRole: v })}
              placeholder="Individual contributor"
            />
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button onClick={() => void save()} disabled={isLoading} className="gap-1.5">
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={isLoading}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid min-w-0 flex-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">
                  {name || <span className="text-muted-foreground">No name yet</span>}
                </p>
                <p className="truncate text-sm">
                  {email ? (
                    <a href={`mailto:${email}`} className="text-primary underline-offset-2 hover:underline">
                      {email}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">
                      No address from your sign-in provider
                    </span>
                  )}
                </p>
                {/* Dots, and a sentence saying whose password they are. Recallix
                    never sees it: Clerk holds it, and a development session is
                    identified by a header and has none at all. */}
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="tracking-[0.2em]">•••••••••</span>
                  <span className="text-xs">
                    {mode === "clerk"
                      ? "Managed by your sign-in provider"
                      : "Development session — no password"}
                  </span>
                </p>
              </div>
              <div className="min-w-0 text-sm">
                <p className="truncate">
                  {prefs.data?.department || (
                    <span className="text-muted-foreground">No department</span>
                  )}
                </p>
                <p className="truncate text-muted-foreground">
                  {prefs.data?.jobRole || "No role"}
                </p>
              </div>
            </div>

            <Button variant="outline" size="sm" onClick={open} className="shrink-0 gap-1.5">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          </>
        )}
      </div>
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

/** A row that navigates somewhere else — the shape of Manage Vocabulary. */
/**
 * What Recallix is told before it listens.
 *
 * <p>Here rather than behind a link. It lived on a Meetings tab, and this page
 * carried a row that navigated to it — which was already one click of
 * indirection around two small cards. That tab is gone, so the choice was to
 * move these or to lose them, and losing them would take a working feature off
 * the product to tidy a settings page.
 *
 * <p>Both apply to meetings processed from now on. An existing transcript has to
 * be reprocessed to pick them up, and the copy says so, because the alternative
 * is somebody adding a name and wondering why last week's meeting still spells
 * it wrong.
 */
function TranscriptionSection() {
  return (
    <section id="vocabulary" aria-labelledby="transcription-heading" className="space-y-4 py-4">
      <div>
        <h2
          id="transcription-heading"
          className="flex items-center gap-2 text-lg font-semibold"
        >
          <SpellCheck className="h-4 w-4 text-muted-foreground" /> Words and speakers
        </h2>
        <p className="text-sm text-muted-foreground">
          What Recallix is told before it listens. Both apply to meetings
          processed from now on — an existing transcript has to be reprocessed
          to pick them up.
        </p>
      </div>
      <VocabularyCard />
      <KnownSpeakersCard />
    </section>
  );
}

function SettingRow({
  icon,
  title,
  description,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href} className="block border-b py-4 transition-colors hover:bg-accent/40">
      <Row
        icon={icon}
        title={title}
        description={description}
        bare
        action={<ChevronRight className="h-4 w-4 text-muted-foreground" />}
      />
    </Link>
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
 * What is running, and the documents that govern it.
 *
 * <p>The build line is real or it is not there: the version comes from
 * package.json and the commit from a build argument, so a container built
 * without one says "dev" rather than inventing a hash. The legal links appear
 * only when somebody has supplied the URLs — Recallix ships no terms of service
 * or privacy policy of its own, and a link to a page that does not exist is
 * worse than no link.
 */
function Footer() {
  return (
    <div className="space-y-1 pt-8 text-center text-xs text-muted-foreground">
      <p>{BUILD_LINE}</p>
      {LEGAL_LINKS.length > 0 && (
        <p>
          By using Recallix you agree to the{" "}
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
      )}
      <p>
        <Link href="/settings/security" className="underline-offset-2 hover:underline">
          What Recallix holds of yours
        </Link>
      </p>
    </div>
  );
}
