import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@/components/ui/toast";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { switchOrganizationMutationOptions } from "@/lib/organizations/mutations";
import { queryClient } from "@/query-client";

/** The one toast a switch that did not finish says itself in. */
const SWITCH_TOAST = "organization-switch-unfinished";

/**
 * Work in another organization, from home.
 *
 * Once the server has switched, the person is taken home before the app changes over, so the
 * conversation or Bot that was open closes and is never asked for in the organization it is not
 * in. A switch the server refused leaves them where they were, told so in a toast.
 */
export function useSwitchOrganization() {
  const navigate = useNavigate();
  const current = useCurrentOrganizationId();
  const switching = useMutation(
    switchOrganizationMutationOptions(queryClient, async () => {
      await navigate({ to: "/" });
    }),
  );
  return {
    pending: switching.isPending,
    run: (organizationId: string) => {
      if (switching.isPending || organizationId === current) return;
      switching.mutate(organizationId, {
        onSuccess: () => toast.close(SWITCH_TOAST),
        onError: (error) =>
          toast.add({
            // One at a time: a second refusal replaces the first.
            id: SWITCH_TOAST,
            title: error.message,
            type: "error",
            priority: "high",
          }),
      });
    },
  };
}
