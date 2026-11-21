import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openTeamFeatures } from "@/components/edition/team-features-dialog";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

/**
 * The bar offering help self-hosting OpenBot, until this person closes it.
 *
 * Hidden until both answers are in, so it never flashes on and then off: the deployment has to say
 * the banner is on (a fork running OpenBot for its own people turns it off), and this person's
 * preferences have to say they have not closed it.
 *
 * Talk to an engineer opens the OpenBot for Business dialog, where the calendar is, in the app.
 * Dismiss sits at the bar's far end, where Figma draws it. On localhost CopilotKit's dev inspector
 * can float over that corner; it is a developer's tool, and this bar is drawn for everybody else.
 */
export function SelfHostBanner() {
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissSelfHostBannerMutationOptions(queryClient, userId),
  );

  if (!capabilities?.selfHostBanner) return null;
  if (!preferences || preferences.selfHostBannerDismissed) return null;

  return (
    <AnnouncementBar
      action="Talk to an engineer"
      label="Self-host OpenBot"
      message="Self-host OpenBot for your organization."
      onAction={openTeamFeatures}
      onDismiss={() => dismiss.mutate()}
    />
  );
}
