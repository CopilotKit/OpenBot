import { IconStar } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import {
  answerStarPromptMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { OPENBOT_REPO_URL, recordStarPrompt } from "@/lib/star-prompt";

/**
 * Settings → General's permanent way to star OpenBot on GitHub: the quiet half of the ask whose
 * active half is the card above the composer (`components/star-prompt/star-prompt.tsx`).
 *
 * Here whenever the deployment allows the ask at all, and gone with it when the operator set
 * OPENBOT_STAR_PROMPT=false. Unlike the card it stays after an answer, because somebody who said
 * Not now may want it later and this is where they would look. Pressing it is counted under
 * `settings`, and answers the card, so somebody who starred from here is not asked again.
 */
export function StarOnGitHubSection() {
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const answer = useMutation(
    answerStarPromptMutationOptions(queryClient, userId),
  );
  if (capabilities?.starPrompt !== true) return null;

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
              OpenBot is open source. A star helps other people find it.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <a
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={OPENBOT_REPO_URL}
              onClick={() => {
                void recordStarPrompt("star_prompt_clicked", "settings");
                if (preferences?.starPromptAnswered !== true) answer.mutate();
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
