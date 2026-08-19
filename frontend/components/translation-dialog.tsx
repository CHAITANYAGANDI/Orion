"use client";

/**
 * Choosing what language to read a meeting in.
 *
 * <p>This was a bar under the audio player, permanently on screen and reading
 * "English (original)" — which is to say, on the overwhelming majority of
 * meetings it occupied a row of the page to report that nothing had happened.
 * It also sat two controls away from the menu item called "Change language…",
 * and the pair read as one feature offered twice. It is a dialog behind the ⋯
 * menu now, opened by people who want it.
 *
 * <p>A list rather than the select it used to be, for the reason the Move
 * dialog is a list: a dialog is somewhere you went on purpose, so it can show
 * every option at once, mark the current one, and have room to say what a
 * translation is and is not.
 *
 * <p>The original is always the first row and is named by its own language
 * rather than called "original", because "English" is what the reader is
 * choosing between — and because the meeting's own language is the one thing
 * here that is a fact rather than a preference.
 *
 * <p>{@link ReadingIn} is the other half and cannot be dropped. Once the
 * control is behind a menu, a translated summary looks exactly like an original
 * one, and a reader who does not know they are reading a translation will quote
 * it as what somebody said. It lives in the meeting's spec line and exists only
 * while it is true.
 */

import * as React from "react";
import { Check, Languages, Loader2, RefreshCw } from "lucide-react";
import { useGetLanguagesQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AvailableTranslation, MeetingTranslation } from "@/lib/types";

/** The value the picker uses for "leave it in the language it was held in". */
export const ORIGINAL = "__original__";

/** The base language of a tag like "en-US", lowercased. */
function base(code: string | null | undefined): string {
  return (code ?? "").split(/[-_]/)[0].toLowerCase();
}

export function TranslationDialog({
  open,
  onOpenChange,
  sourceLanguage,
  value,
  onChange,
  available,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The meeting's own language, if it was detected. */
  sourceLanguage?: string | null;
  /** An ISO code, or {@link ORIGINAL}. */
  value: string;
  onChange: (value: string) => void;
  available?: AvailableTranslation[];
  busy: boolean;
}) {
  const { data: languages } = useGetLanguagesQuery();

  // The meeting is already in this language; offering to translate it into
  // itself is an option that can only waste a model call.
  const source = base(sourceLanguage);
  const options = (languages ?? []).filter((l) => l.code !== source);
  const sourceName = languages?.find((l) => l.code === source)?.name ?? "the original";
  const done = new Set((available ?? []).map((a) => a.language));

  function pick(next: string) {
    onOpenChange(false);
    if (next !== value) onChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Read this meeting in another language</DialogTitle>
          <DialogDescription>
            The recording and the transcript stay in {sourceName}. This
            translates what you read — the brief, the tasks and the transcript —
            and you can switch back at any time.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-72 space-y-1 overflow-y-auto py-1">
          <Row
            label={sourceLanguage ? `${sourceName} (original)` : "Original"}
            hint="What was actually said"
            selected={value === ORIGINAL}
            disabled={busy}
            onSelect={() => pick(ORIGINAL)}
          />
          {options.map((l) => (
            <Row
              key={l.code}
              label={l.name}
              hint={
                // Already paid for. Worth saying, because the difference
                // between an instant switch and a thirty-second one is the
                // difference between browsing and committing.
                done.has(l.code)
                  ? "Already translated"
                  : l.nativeName === l.name
                    ? undefined
                    : l.nativeName
              }
              selected={value === l.code}
              disabled={busy}
              onSelect={() => pick(l.code)}
            />
          ))}
        </ul>

        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Translating…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
          "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
          selected && "bg-accent",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        </span>
        {selected && <Check className="h-4 w-4 shrink-0" />}
      </button>
    </li>
  );
}

/**
 * That you are not reading the meeting's own words.
 *
 * <p>Renders nothing at all in the ordinary case, which is the point: the row
 * this replaced was on screen always and said "English (original)" nearly
 * always. Here there is no indicator until there is something to indicate.
 */
export function ReadingIn({
  sourceLanguage,
  language,
  translation,
  busy,
  onShowOriginal,
  onRetranslate,
}: {
  sourceLanguage?: string | null;
  /** An ISO code, or {@link ORIGINAL}. */
  language: string;
  translation?: MeetingTranslation;
  busy: boolean;
  onShowOriginal: () => void;
  onRetranslate: () => void;
}) {
  const { data: languages } = useGetLanguagesQuery();

  if (language === ORIGINAL && !busy) return null;

  const name = languages?.find((l) => l.code === base(language))?.name ?? language;
  const sourceName =
    languages?.find((l) => l.code === base(sourceLanguage))?.name ?? "the original";

  return (
    <span className="no-print flex flex-wrap items-center gap-2">
      <span className="text-border" aria-hidden>
        /
      </span>
      {busy ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Translating into {name}…
        </span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 uppercase tracking-wide">
            <Languages className="h-3.5 w-3.5" />
            Reading in {name}
          </span>
          <button
            type="button"
            onClick={onShowOriginal}
            className="uppercase tracking-wide underline underline-offset-2 hover:text-foreground"
          >
            Show {sourceName}
          </button>
          {/* Stale beats out of the way. A translation of a summary that has
              since been rewritten quotes something nobody says any more, and
              this is the only place that can be said while it is being read. */}
          {translation?.stale && (
            <>
              <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs normal-case text-amber-500">
                Translated before the meeting last changed
              </span>
              <Button variant="outline" size="sm" className="h-6 gap-1.5" onClick={onRetranslate}>
                <RefreshCw className="h-3 w-3" />
                Retranslate
              </Button>
            </>
          )}
        </>
      )}
    </span>
  );
}
