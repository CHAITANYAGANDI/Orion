/**
 * ISO-639-1 code -> the language's name in the browser's own locale.
 *
 * `Intl.DisplayNames` already ships this table, so there is no reason to keep a
 * hand-written map that would inevitably drift. It throws on codes it cannot
 * parse, and is missing in older browsers, so the raw code is the fallback —
 * "pt-BR" is still more informative than nothing.
 */
export function languageName(code: string | null | undefined): string {
  if (!code) return "";
  const trimmed = code.trim();
  if (!trimmed) return "";
  try {
    const names = new Intl.DisplayNames(undefined, { type: "language" });
    return names.of(trimmed) ?? trimmed;
  } catch {
    return trimmed;
  }
}
