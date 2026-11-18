/** The roles this app knows. A newer server may answer one it doesn't. */
export type KnownRole = "owner" | "admin" | "member";

/**
 * Whether a role administers its organization.
 *
 * The one place the app decides it. A person's role is their role as a member of the organization
 * they are working in (the API's `PersonRole`): an owner, who created it, governs it exactly as an
 * admin does, so everything offered to an admin is offered to an owner. The server decides the same
 * way and refuses whatever the app should not have offered.
 */
export function isOrganizationAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "owner";
}

/**
 * A role as the server answered it, read as one this app knows. The list of roles can grow, and a role
 * this app doesn't know is read as the least it could be: a member.
 */
export function knownRole(role: string | null | undefined): KnownRole {
  return role === "owner" || role === "admin" ? role : "member";
}

/** Whether a role is one this app knows, and so can name and give. */
export function isKnownRole(role: string): role is KnownRole {
  return role === "owner" || role === "admin" || role === "member";
}
