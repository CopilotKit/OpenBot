import { STAR_ON_GITHUB } from "@openbot/shared/notices";
import { IconStar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { OPENBOT_REPO_URL } from "@/components/star-prompt/star-prompt";
import { buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { recordNudge } from "@/lib/notices";
import {
  dismissNoticeMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * Settings → General's permanent way to star OpenBot on GitHub: the quiet half of the ask whose
 * active half is the card above the message box (`components/star-prompt/star-prompt.tsx`).
 *
 * Only in the personal edition, like the card: a team's or a company's OpenBot never asks its
 * people for a star. Unlike the card it stays after an answer, because somebody who said Not now
 * may want it later and this is where they would look. Pressing it is counted under `settings`, and
 * answers the card, so somebody who starred from here is not asked again.
 */
export function StarOnGitHubSection() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissNoticeMutationOptions(queryClient, userId),
  );
  if (capabilities?.edition !== "personal") return null;

  return (
    <PageSection title="OpenBot">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconStar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Star OpenBot on GitHub</ItemTitle>
            <ItemDescription>
              OpenBot is open source. A star helps us keep making it better.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <a
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={OPENBOT_REPO_URL}
              onClick={() => {
                void recordNudge(STAR_ON_GITHUB, "clicked", "settings");
                if (
                  preferences &&
                  !(preferences.dismissedNotices ?? []).includes(STAR_ON_GITHUB)
                )
                  dismiss.mutate(STAR_ON_GITHUB);
              }}
              rel="noopener noreferrer"
              target="_blank"
            >
              Star on GitHub
            </a>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
