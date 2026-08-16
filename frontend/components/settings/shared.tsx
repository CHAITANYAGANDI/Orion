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

export function settingsError(err: unknown): string {
  if (typeof err === "object" && err && "data" in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  if (err instanceof Error) return err.message;
  return "Couldn't save that.";
}
