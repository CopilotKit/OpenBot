import { IconRadar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { proactiveAllowedQueryOptions } from "@/lib/proactive";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * The person's own switch for every one of their Bots' check-ins at once. Off stops every Bot's
 * background checks for them before any model call; each Bot's own setting is kept, so turning this
 * back on restores them as they were.
 *
 * When an admin turned check-ins off for this person, the switch is off and cannot be changed, and
 * says who turned it off. Their own choice is kept underneath for when the admin turns it back on.
 */
export function CheckInsSection() {
  const preferences = useUserPreferences();
  const allowed = useQuery(proactiveAllowedQueryOptions());
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  // The switch follows the press while the save is out, and the stored answer after.
  const chosen =
    (save.isPending ? save.variables?.proactive : undefined) ??
    preferences.data?.proactive;
  const byAdmin = allowed.data === false;
  const on = chosen === "on" && !byAdmin;
  return (
    <PageSection
      description="Your Bots check the apps they can read and tell you when something needs you, at most once an hour. They never act without asking."
      title="Check-ins"
    >
      {preferences.isPending ? null : preferences.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your check-ins. Reload the page.
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconRadar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>All your Bots</ItemTitle>
              <ItemDescription>
                {byAdmin
                  ? "Turned off by your admin."
                  : on
                    ? "On. Each Bot's own check-ins are on its Memory page."
                    : "Off. None of your Bots check in for you."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Check-ins for all your Bots"
                checked={on}
                disabled={byAdmin || save.isPending}
                onCheckedChange={(next) =>
                  save.mutate({ proactive: next ? "on" : "off" })
                }
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
      {save.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
