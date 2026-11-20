/**
 * The two rules the box for adding people to a team draws by: what it completes in the box as
 * somebody types, and which part of a name or address it shows in bold. The server decides who
 * matches (listOrganizationMembers with search); these only draw what it found.
 */

type Named = { name: string | null; email: string };

/**
 * A person's name, or else their address, when it starts with what was typed, ignoring case, and is
 * longer: what the box completes to. It is written as the person's own (typing "ma" completes to
 * "Marcus Bell"), as the WAI-ARIA combobox example writes the option's own text, with the part not
 * typed selected after the caret, so Tab takes it and typing on replaces it. Empty when neither
 * starts with it, or nothing is typed.
 */
export function completionOf(person: Named, typed: string): string {
  if (typed.trim() === "") return "";
  const wanted = typed.toLowerCase();
  for (const whole of [person.name, person.email]) {
    if (
      whole &&
      whole.length > typed.length &&
      whole.toLowerCase().startsWith(wanted)
    )
      return whole;
  }
  return "";
}

/**
 * Where what was typed shows in a name or address, as the server matched it: at the start, else at
 * the start of a word (a last name), else anywhere. `[start, end]`, or null when it is not there.
 */
export function matchIn(text: string, typed: string): [number, number] | null {
  const wanted = typed.trim().toLowerCase();
  if (wanted === "") return null;
  const lower = text.toLowerCase();
  if (lower.startsWith(wanted)) return [0, wanted.length];
  const word = lower.indexOf(` ${wanted}`);
  if (word >= 0) return [word + 1, word + 1 + wanted.length];
  const anywhere = lower.indexOf(wanted);
  return anywhere >= 0 ? [anywhere, anywhere + wanted.length] : null;
}
