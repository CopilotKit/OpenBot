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
