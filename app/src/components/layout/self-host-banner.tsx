import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";

/** `ref` tells CopilotKit the visit came from inside a running OpenBot, not from the README. */
export const SELF_HOST_URL =
  "https://copilotkit.ai/talk-to-an-engineer?ref=openbot_app";

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
      className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      {/*
       * Packed from the left rather than pushing Dismiss to the far right: on localhost CopilotKit's
       * dev inspector floats over the top-right corner, which is where somebody trying OpenBot first
       * sees this, and a Dismiss under it cannot be clicked.
       */}
      <p className="min-w-0 truncate text-foreground">
        Self-host OpenBot for your organization.
      </p>
      {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
      <a
        // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
        className={cn(
          buttonVariants({ size: "sm", variant: "link" }),
          "text-foreground underline",
        )}
        href={SELF_HOST_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        Talk to an engineer
      </a>
      <Button
        aria-label="Dismiss"
        onClick={() => dismiss.mutate()}
        size="icon-xs"
        variant="ghost"
      >
        <IconX />
      </Button>
    </aside>
  );
}
