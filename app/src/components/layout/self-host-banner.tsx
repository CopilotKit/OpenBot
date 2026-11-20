import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openTeamFeatures } from "@/components/edition/team-features-dialog";
import { Button } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

/**
 * A slim bar offering help self-hosting OpenBot, until this person closes it.
 *
 * Hidden until both answers are in, so it never flashes on and then off: the deployment has to say
 * the banner is on (a fork running OpenBot for its own people turns it off), and this person's
 * preferences have to say they have not closed it.
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
    <aside
      aria-label="Self-host OpenBot"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      {/*
       * Packed from the left rather than pushing Dismiss to the far right: on localhost CopilotKit's
       * dev inspector floats over the top-right corner, which is where somebody trying OpenBot first
       * sees this, and a Dismiss under it cannot be clicked.
       *
       * Wraps rather than truncates, so a phone reads the whole sentence. The link and Dismiss stay
       * together and drop to the next line as one, which keeps Dismiss on the left there too.
       */}
      <p className="text-foreground">
        Self-host OpenBot for your organization.
      </p>
      <span className="flex items-center gap-2">
        {/* Opens the OpenBot for Business dialog, where the calendar is, in the app. */}
        <Button
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className="px-0 text-foreground underline"
          onClick={openTeamFeatures}
          size="sm"
          variant="link"
        >
          Book a call
        </Button>
        <Button
          aria-label="Dismiss"
          onClick={() => dismiss.mutate()}
          size="icon-xs"
          variant="ghost"
        >
          <IconX />
        </Button>
      </span>
    </aside>
  );
}
