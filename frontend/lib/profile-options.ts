/**
 * The lists behind the Department and Role pickers.
 *
 * Short on purpose. A dropdown of sixty departments is worse than a text box:
 * nobody scrolls it, and the twelve that cover almost everybody are faster to
 * pick from. Neither field routes anything — they are descriptive — so being
 * approximately right costs nothing.
 */

export const DEPARTMENTS = [
  "Engineering",
  "IT",
  "Product",
  "Design",
  "Data",
  "Sales",
  "Marketing",
  "Customer Success",
  "Finance",
  "People",
  "Legal",
  "Operations",
];

export const ROLES = [
  "Individual contributor",
  "Team lead",
  "Manager",
  "Director",
  "VP",
  "Executive",
  "Founder",
  "Consultant",
  "Student",
];

/**
 * The list, with whatever is already stored kept in it.
 *
 * Both fields were free text before these lists existed, so an account may hold
 * "Platform Engineering" or "Staff Engineer". Rendering a `<select>` whose value
 * is absent from its options shows the first option instead, so opening this
 * dialog to change a photo would silently rewrite somebody's department — a
 * data loss with no prompt and no undo.
 *
 * The stored value goes first because that is what the control is showing.
 */
export function withCurrent(options: string[], current?: string | null): string[] {
  const value = (current ?? "").trim();
  if (!value || options.includes(value)) return options;
  return [value, ...options];
}
