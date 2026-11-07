import { useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Whether there is a sign-in here for Sign out to end.
 *
 * Not on a single-person install (OpenBot Desktop, `OPENBOT_SINGLE_USER`): nobody signs in, the one
 * person is whoever is at this machine, and the server has no session to end. Offering Sign out
 * there only ever answered "No identity provider is configured." and left the person where they
 * were. Off until the deployment has said, so a single-person install never flashes it.
 */
export function useSignOutOffered(): boolean {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return capabilities.data?.localEvaluation === false;
}
