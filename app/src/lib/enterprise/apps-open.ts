import { useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appsSettingQueryOptions } from "@/lib/enterprise/queries";

/**
 * Whether apps are open here: anybody in the organization adds and connects an app the organization
 * hasn't added, the Bot's owner gives it to their Bot, and nobody is sent to ask an admin for either.
 * Locked down, a member asks an admin, as before the switch existed.
 *
 * The personal edition is always open: its one person is its admin. The team edition reads the
 * organization's switch (`appsSettingQueryOptions`), which every member may read.
 *
 * `undefined` while that is on its way, so a screen can wait rather than draw one mode's buttons and
 * then swap them for the other's. A read that failed is locked down: the screens then offer what
 * they always have, which works in both modes, and the server decides every press either way.
 */
export function useAppsOpen(): boolean | undefined {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const personal = capabilities.data?.edition === "personal";
  // A capabilities read that failed is read as the team edition, as every screen reads it.
  const team = capabilities.data ? !personal : capabilities.isError;
  const setting = useQuery({ ...appsSettingQueryOptions(), enabled: team });
  if (personal) return true;
  if (capabilities.isPending) return undefined;
  if (setting.isPending) return undefined;
  return setting.data?.lockedDown === false;
}
