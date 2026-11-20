import { ORGANIZATION_ID } from "./api";
import { createCompanySignInTicket } from "./api/generated/people/people";

/**
 * A single-use ticket to link the person's company account where they work (./link-company.ts). `returnTo: "app"`:
 * once it is linked, OpenBot's page sends the browser back to the app (RETURN_ADDRESS), which ends its session.
 */
export function companySignInTicket(providerId: string) {
  return createCompanySignInTicket(ORGANIZATION_ID, "me", {
    providerId,
    returnTo: "app",
  });
}
