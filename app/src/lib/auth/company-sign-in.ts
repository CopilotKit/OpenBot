import { queryOptions } from "@tanstack/react-query";
import type { CompanySignIn } from "@/lib/api/generated/model";
import { getCompanySignIn } from "@/lib/api/generated/people/people";
import { organizationId } from "@/lib/api/request";

export const companySignInKeys = {
  all: ["company-sign-in"] as const,
  mine: () => ["company-sign-in", "me"] as const,
};

/**
 * Whether this organization requires its members to sign in through their company, whether the person has, and the
 * providers that count for it. The server answers it even while it holds them out (`heldOutBySso`), so the page that
 * says they are held out can offer the way in.
 */
export function companySignInQueryOptions() {
  return queryOptions({
    queryKey: companySignInKeys.mine(),
    queryFn: ({ signal }): Promise<CompanySignIn> =>
      getCompanySignIn(organizationId(), "me", {
        signal,
        fallback: "Couldn't check your company sign-in.",
      }),
  });
}
