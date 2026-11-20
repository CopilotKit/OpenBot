/** The server's code for a member an organization holds out until they sign in through their company. */
export const SSO_REQUIRED = "SSO_REQUIRED";

/**
 * Whether a failure is the organization holding the person out until they sign in through their company's identity
 * provider (Require SSO). An answer, not a fault: every request in the organization says the same until they link
 * their company account, so it is never retried (query-client.ts) and never shown as an error.
 *
 * Read by the refusal's code alone, with nothing imported, so the query client can ask it.
 */
export function heldOutBySso(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SSO_REQUIRED
  );
}
