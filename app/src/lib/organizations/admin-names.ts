/**
 * The organization's admins, named in a sentence that tells a member only an admin can take a step,
 * so they know who to follow up with. Owners come first (`organizationAdminsQueryOptions`); a few are
 * named, and the rest are counted.
 *
 * Never for an admin, who is offered the step itself, and never in the personal edition, which has
 * none. With nobody to name (still being read, or couldn't be), the sentence stands as it was.
 */

/** Who an admin is, as the members list answers them. */
export type AdminName = { name: string | null; email: string };

/** How many are named before the rest are counted. */
const NAMED = 3;

/** One admin as a sentence names them: the name with the address, or whichever there is. */
function named(admin: AdminName, withEmail: boolean): string {
  const name = admin.name?.trim() ?? "";
  const email = admin.email.trim();
  if (!name) return email;
  return withEmail && email ? `${name} (${email})` : name;
}

/** "A", "A and B", "A, B and C", or "A, B, C and 2 more", joined with `last`. */
function list(people: string[], last: "and" | "or"): string {
  const shown = people.slice(0, NAMED);
  const more = people.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length < 2) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} ${last} ${shown.at(-1)}`;
}

/** The ones a sentence can name: anybody with a name or an address. */
function nameable(admins: readonly AdminName[]): string[] {
  return admins
    .map((admin) => named(admin, true))
    .filter((text) => text.length > 0);
}

/**
 * A sentence that ends on the step only an admin can take, with who they are after it:
 * "Only an admin can give it: Priya Raman (priya@northwind.test) or Ines Duarte (ines@northwind.test)."
 * Unchanged with nobody to name.
 */
export function withAdmins(
  sentence: string,
  admins: readonly AdminName[],
): string {
  const people = nameable(admins);
  if (people.length === 0) return sentence;
  return `${sentence.replace(/[.\s]+$/, "")}: ${list(people, "or")}.`;
}

/**
 * Who they are, as a sentence of its own, for beside a sentence this screen didn't write (the
 * server's refusal): "Your admins are Priya Raman (priya@northwind.test) and Ines Duarte
 * (ines@northwind.test)." Empty with nobody to name.
 */
export function yourAdmins(admins: readonly AdminName[]): string {
  const people = nameable(admins);
  if (people.length === 0) return "";
  return people.length === 1
    ? `Your admin is ${people[0]}.`
    : `Your admins are ${list(people, "and")}.`;
}

/** Where a request went: "Sent to Priya Raman and Morgan Reyes." Empty with nobody to name. */
export function sentTo(admins: readonly AdminName[]): string {
  const people = admins
    .map((admin) => named(admin, false))
    .filter((text) => text.length > 0);
  if (people.length === 0) return "";
  return `Sent to ${list(people, "and")}.`;
}
