"use client";

/**
 * The first screen inside a new account.
 *
 * <h2>What an onboarding is allowed to ask for</h2>
 *
 * <p>Two questions and a door. Both questions are settings that already exist,
 * that the product actually reads, and that are worth more answered now than
 * discovered later:
 *
 * <ul>
 *   <li><b>Your name.</b> It is what the account button and My tasks show.
 *       Prefilled from Google where Google knew it, which turns the first step
 *       into a confirmation rather than a question.</li>
 *   <li><b>The language your meetings are in.</b> This one earns its place:
 *       detection is good, and it is fooled by a quiet opening minute — so a
 *       transcript in the wrong language is a real outcome that one tap here
 *       prevents. Auto-detect stays the default, because for most people it is
 *       right.</li>
 * </ul>
 *
 * <p>Nothing else. No company, no team size, no role, no "how did you hear
 * about us" — Reverie has nowhere to put any of it, and a form that collects what
 * it never reads is asking somebody to work for you before you have done
 * anything for them.
 *
 * <h2>Why every step can be skipped</h2>
 *
 * <p>Because the account is already made. This is not a gate — it is the offer
 * of a head start, and holding a working product behind three screens of
 * questions is how a good first minute becomes a closed tab. Skipping leaves
 * the defaults, which are all sound.
 *
 * <h2>Where it sits</h2>
 *
 * <p>Inside `AuthGate` — nothing here can be asked before there is a token to
 * save it with — and outside `AppShell`. A sidebar, a folder tree and a usage
 * meter drawn around a welcome screen would be the application saying "you are
 * already here" while the screen says "let us begin".
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, FileUp, Loader2, Mic } from "lucide-react";
import { AuthGate } from "@/components/auth-gate";
import { AuthShell } from "@/components/auth/auth-shell";
import { Field, SubmitButton } from "@/components/auth/auth-form";
import { useAuth } from "@/lib/auth";
import { useGetLanguagesQuery, useUpdatePreferencesMutation } from "@/lib/api";
import { identityPermissions } from "@/lib/identity-owner";
import { HOME } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** Auto-detect, which is the default and usually right. */
const AUTO = "";

export default function WelcomePage() {
  return (
    <AuthGate>
      <Welcome />
    </AuthGate>
  );
}

function Welcome() {
  const router = useRouter();
  const { mode, profile } = useAuth();
  const [save] = useUpdatePreferencesMutation();

  /*
   * The name step exists only where the name is this account's to set.
   *
   * <p>Signing up with Google means Google holds it -- Settings says exactly
   * that and disables the field -- so asking for it here would be the product
   * contradicting itself two screens apart, and saving it would write a copy
   * into Reverie's column that then outranks Google's everywhere.
   */
  const permissions = identityPermissions({
    mode,
    provider: profile.provider,
    hasPassword: profile.hasPassword,
  });

  const [step, setStep] = React.useState(0);
  const [name, setName] = React.useState("");
  const [language, setLanguage] = React.useState(AUTO);
  const [saving, setSaving] = React.useState(false);

  /*
   * Google's name, once it arrives.
   *
   * `useUser` resolves a moment after this mounts, so seeding state at first
   * render would seed it empty. A ref rather than a dependency on `name` keeps
   * this to "fill the box once, and never overwrite what somebody has typed".
   */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !profile.name) return;
    seeded.current = true;
    setName(profile.name);
  }, [profile.name]);

  const languages = useGetLanguagesQuery();

  /** Save what has been chosen, then leave. Failure is not a reason to trap anybody. */
  async function finish(destination: string) {
    setSaving(true);
    try {
      const patch: { displayName?: string; defaultLanguage?: string } = {};
      if (permissions.name && name.trim()) patch.displayName = name.trim();
      if (language) patch.defaultLanguage = language;
      if (Object.keys(patch).length > 0) await save(patch).unwrap();
    } catch {
      /*
       * Deliberately swallowed. Both of these are settings with sound defaults
       * and their own page in Settings; refusing to let somebody into the
       * product because a preference did not save would be the worst possible
       * first minute. They arrive, and the name is still theirs to set.
       */
    }
    router.push(destination);
  }

  /**
   * The steps this account actually has. Two for a Google sign-in, three for an
   * account made here — and the marker below counts what is there rather than
   * what was planned.
   */
  const steps = permissions.name
    ? (["name", "language", "start"] as const)
    : (["language", "start"] as const);
  const current = steps[step];

  return (
    <AuthShell
      eyebrow={`Step ${step + 1} of ${steps.length}`}
      title={
        current === "name"
          ? "What should we call you?"
          : current === "language"
            ? "What language are your meetings in?"
            : "You are set up."
      }
      subtitle={
        current === "name" ? (
          "It appears on your account and beside the tasks assigned to you."
        ) : current === "language" ? (
          "Reverie detects this from the audio. Fixing it helps when a meeting opens quietly."
        ) : (
          <>Bring in a recording you already have, or make one now.</>
        )
      }
      footer={
        <div className="flex items-center justify-between">
          {/* A real sequence, so the markers carry real information: which of
              three, and which are done. */}
          <div className="flex items-center gap-1.5" aria-hidden>
            {steps.map((id, i) => (
              <span
                key={id}
                className={cn(
                  "h-1 rounded-full transition-all duration-300",
                  i === step ? "w-6 bg-foreground" : "w-1.5 bg-border",
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => void finish(HOME)}
            disabled={saving}
            className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-60"
          >
            Skip for now
          </button>
        </div>
      }
    >
      {current === "name" ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(step + 1);
          }}
        >
          <Field
            label="Name"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <SubmitButton>
            Continue <ArrowRight className="h-4 w-4" />
          </SubmitButton>
        </form>
      ) : null}

      {current === "language" ? (
        <div className="space-y-4">
          <div className="max-h-[280px] space-y-1 overflow-y-auto pr-1">
            <LanguageRow
              label="Detect automatically"
              detail="Recommended"
              selected={language === AUTO}
              onSelect={() => setLanguage(AUTO)}
            />
            {languages.data?.map((option) => (
              <LanguageRow
                key={option.code}
                label={option.name}
                detail={option.nativeName}
                selected={language === option.code}
                onSelect={() => setLanguage(option.code)}
              />
            ))}
            {languages.isLoading ? (
              <p className="px-1 py-3 text-[13px] text-muted-foreground">Loading languages…</p>
            ) : null}
          </div>
          <SubmitButton onClick={() => setStep(step + 1)} type="button">
            Continue <ArrowRight className="h-4 w-4" />
          </SubmitButton>
        </div>
      ) : null}

      {current === "start" ? (
        <div className="space-y-3">
          <StartRow
            icon={Mic}
            title="Record a meeting"
            detail="Capture it in this browser, live."
            onClick={() => void finish("/record?r=%2Fhome")}
            busy={saving}
          />
          <StartRow
            icon={FileUp}
            title="Import a file"
            detail="Audio or video you already have."
            onClick={() => void finish("/upload")}
            busy={saving}
          />
          <StartRow
            icon={ArrowRight}
            title="Just take me in"
            detail="Everything is set. You can start any time."
            onClick={() => void finish(HOME)}
            busy={saving}
          />
        </div>
      ) : null}
    </AuthShell>
  );
}

/** One language. A radio in behaviour, a row in appearance. */
function LanguageRow({
  label,
  detail,
  selected,
  onSelect,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        "outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex-1 text-[14px]">{label}</span>
      <span className="text-[12px] text-muted-foreground">{detail}</span>
      <Check
        className={cn("h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
    </button>
  );
}

/** One way to begin. */
function StartRow({
  icon: Icon,
  title,
  detail,
  onClick,
  busy,
}: {
  icon: typeof Mic;
  title: string;
  detail: string;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-lg border bg-card px-4 py-3.5 text-left",
        "transition-colors hover:bg-accent",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:opacity-60",
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12.5px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
