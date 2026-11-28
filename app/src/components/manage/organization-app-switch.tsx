import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { removePluginServerMutationOptions } from "@/lib/apps/mutations";
import { type Failure, failureSaid } from "@/lib/load-failure";
import { queryClient } from "@/query-client";

/**
 * The words of the switch that turns an app off for the whole organization, in the team edition.
 * Admin's page for the app draws them, and so does the app's page under Connections for an admin, so
 * the two say the same thing about the same decision.
 *
 * DRAWN ONLY ONCE THE APP IS ADDED, and worded as what switching it does: turning it off for
 * everyone. Adding the app is never a step of its own: Connect adds it and goes on to the admin's own
 * account in one press. "Enable for this organization" was a step before Connect, and nobody reads
 * "turn it on, then connect it" as one thing.
 */
export const ORGANIZATION_SWITCH = {
  title: "On for everyone",
  on: "Everyone in the organization can connect it, and Bots can be given its tools. Turning this off removes it for everyone, along with every Bot's access to its tools.",
  label: (title: string) => `${title} on for everyone in the organization`,
} as const;

/**
 * Admin's "On for everyone" row, for an app that is on, drawn on the app's page under
 * Connections for an organization's owner or admin. Turning it off removes the app for everybody, as
 * it does in Admin, and goes back to Connections, where the app is no longer listed. Then a person
 * who runs their own organization (OpenBot Cloud's usual case) adds and removes an app without
 * opening Admin. A member is never shown it: the server refuses them.
 */
export function OrganizationAppSwitch({
  appId,
  title,
}: {
  appId: string;
  title: string;
}) {
  const navigate = useNavigate();
  // The error itself, not its words, so a hold is drawn calmly (lib/load-failure.tsx).
  const [error, setError] = useState<Failure | null>(null);
  const remove = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown),
    onSuccess: async () => {
      await navigate({ to: "/connections" });
    },
  });
  return (
    <Item data-testid="organization-app-switch" size="sm">
      <ItemContent>
        <ItemTitle>{ORGANIZATION_SWITCH.title}</ItemTitle>
        <ItemDescription>{ORGANIZATION_SWITCH.on}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={ORGANIZATION_SWITCH.label(title)}
          checked={!remove.isPending && !remove.isSuccess}
          disabled={remove.isPending}
          onCheckedChange={(next) => {
            if (next) return;
            setError(null);
            remove.mutate(appId);
          }}
        />
      </ItemActions>
      {error ? (
        <ItemFooter>
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(error)}
          </p>
        </ItemFooter>
      ) : null}
    </Item>
  );
}
