"use client";

/**
 * The two things every settings tab needs and neither should re-implement.
 *
 * A toggle row that looks the same on all seven tabs, and one reading of an
 * error. The second matters more than it looks: the API's own `message` is the
 * useful part — "Keep meetings at least as long as recordings" beats "Couldn't
 * save that" — and a tab that forgot to unwrap it turns an explained refusal
 * into a shrug.
 */

import * as React from "react";

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    /* A row, not a bordered box. Six of these stacked is six outlines and
       five double-borders where they meet — the classic settings page that
       reads as a stack of cards. A hairline between them and generous height
       says the same thing with none of the furniture, and the whole row stays
       the label so the tap target is the width of the page. */
    <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <span className="text-callout text-ink-2">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[hsl(var(--brand))]"
      />
    </label>
  );
}

/**
 * Why a setting could not be saved.
 *
 * <p>The server's own message when it wrote one — those are sentences meant to
 * be read. Never the `Error`: "Failed to fetch" and friends describe the
 * transport, not the thing the user just tried to change.
 */
export function settingsError(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return "Couldn't save that.";
}
