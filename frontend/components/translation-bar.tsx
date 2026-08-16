"use client";

/**
 * Choosing what language to read a meeting in.
 *
 * <p>It sits above the tabs rather than inside the summary, because a language
 * is a property of the whole meeting: the brief, the action items and the
 * transcript are all read in it. When this control lived on the summary panel
 * it looked like a way to translate that one card, and the two tabs beside it
 * stayed in a language the reader had just said they did not want.
 *
 * <p>The original is always one click away and is labelled by its own language
 * rather than as "original", because "English" is what the reader is choosing
 * between — and because the meeting's own language is the one thing here that is
 * a fact rather than a preference.
 */

import * as React from "react";
import { Languages, Loader2, RefreshCw } from "lucide-react";
import { useGetLanguagesQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AvailableTranslation, MeetingTranslation } from "@/lib/types";

/** The value the picker uses for "leave it in the language it was held in". */
export const ORIGINAL = "__original__";

export function TranslationBar({
  sourceLanguage,
  value,
  onChange,
  translation,
  available,
  busy,
  onRetranslate,
}: {
  /** The meeting's own language, if it was detected. */
  sourceLanguage?: string | null;
  /** An ISO code, or {@link ORIGINAL}. */
  value: string;
  onChange: (value: string) => void;
  /** The active translation, once there is one. */
  translation?: MeetingTranslation;
  available?: AvailableTranslation[];
  busy: boolean;
  onRetranslate: () => void;
}) {
  const { data: languages } = useGetLanguagesQuery();

  // The meeting is already in this language; offering to translate it into
  // itself is an option that can only waste a model call.
  const source = (sourceLanguage ?? "").split(/[-_]/)[0].toLowerCase();
  const options = (languages ?? []).filter((l) => l.code !== source);
  const sourceName =
    languages?.find((l) => l.code === source)?.name ?? "the original";
  const done = new Set((available ?? []).map((a) => a.language));

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Select value={value} onValueChange={onChange} disabled={busy}>
        <SelectTrigger className="h-8 w-[210px]" aria-label="Reading language">
          {busy ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Translating…
            </span>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ORIGINAL}>
            {sourceLanguage ? `${sourceName} (original)` : "Original"}
          </SelectItem>
          {options.map((l) => (
            <SelectItem key={l.code} value={l.code}>
              {l.name}
              <span className="ml-2 text-muted-foreground">{l.nativeName}</span>
              {/* Already paid for. Worth showing, because the difference
                  between an instant switch and a thirty-second one is the
                  difference between browsing and committing. */}
              {done.has(l.code) && <span className="ml-2 text-xs text-muted-foreground">·</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {translation && !busy && (
        <>
          <span className="text-xs text-muted-foreground">
            Translated by Recallix — the recording is still in {sourceName}.
          </span>
          {translation.stale && (
            <Button variant="outline" size="sm" onClick={onRetranslate}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retranslate
            </Button>
          )}
        </>
      )}

      {translation?.stale && !busy && (
        <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-500">
          The meeting changed after this was translated.
        </span>
      )}
    </div>
  );
}
