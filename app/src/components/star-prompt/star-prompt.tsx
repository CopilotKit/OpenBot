import { IconStar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  answerStarPromptMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import {
  firstStarPromptShow,
  OPENBOT_REPO_URL,
  recordStarPrompt,
  STAR_PROMPT_TRIGGER,
  type StarPromptEvent,
  type StarPromptTrigger,
  starPromptEarned,
} from "@/lib/star-prompt";
import { queryClient } from "@/query-client";

/**
 * The ask to star OpenBot on GitHub, once this browser has reached the moment it asks at (see
 * `lib/star-prompt.ts`). The same card as the notifications offer above it, so it reads as part of
 * the composer rather than as an interruption, and never a dialog.
 *
 * Hidden until every answer is in, so it never flashes on and then off: the deployment has to allow
 * it, and this person's preferences have to have loaded and say they have not answered it. Either
 * button answers it, on every device they sign in from, and is counted with the trigger that asked.
 *
 * THE APP'S QUERY CLIENT, NAMED. This is drawn inside the conversation, whose components read no
 * query context of their own (`voice-call-widget.tsx` names it the same way), so it does not depend
 * on a provider being above it.
 */
export function StarPrompt({
  trigger = STAR_PROMPT_TRIGGER,
}: {
  trigger?: StarPromptTrigger;
}) {
  const { data: capabilities } = useQuery(
    deploymentCapabilitiesQueryOptions(),
    queryClient,
  );
  const userId = useQuery(currentUserQueryOptions(), queryClient).data?.id;
  const { data: preferences } = useQuery(
    userPreferencesQueryOptions(userId),
    queryClient,
  );
  const answer = useMutation(
    answerStarPromptMutationOptions(queryClient, userId),
    queryClient,
  );
  const shown =
    capabilities?.starPrompt === true &&
    preferences !== undefined &&
    preferences.starPromptAnswered !== true &&
    starPromptEarned(trigger);

  // Once per browser and trigger; the server keys the count on the person, so this is people.
  useEffect(() => {
    if (shown && firstStarPromptShow(trigger))
      void recordStarPrompt("star_prompt_shown", trigger);
  }, [shown, trigger]);

  if (!shown) return null;

  const respond = (kind: StarPromptEvent) => {
    void recordStarPrompt(kind, trigger);
    answer.mutate();
  };

  return (
    <Item
      // The composer's own surface, as the notifications offer does.
      className="mb-2 bg-card"
      data-star-prompt=""
      size="sm"
      variant="outline"
    >
      <ItemMedia variant="icon">
        <IconStar />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="text-pretty">
          Enjoying OpenBot? Star it on GitHub so more people find it.
        </ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button
          onClick={() => respond("star_prompt_dismissed")}
          size="sm"
          variant="ghost"
        >
          Not now
        </Button>
        {/*
         * A link, not a button that opens one: it goes somewhere, and a person can see where before
         * they go. A new tab in a browser; OpenBot Desktop opens it in the system browser, where
         * they are signed in to GitHub (`desktop/src-tauri/src/outside-links.js`).
         */}
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          href={OPENBOT_REPO_URL}
          onClick={() => respond("star_prompt_clicked")}
          rel="noopener noreferrer"
          target="_blank"
        >
          Star on GitHub
        </a>
      </ItemActions>
    </Item>
  );
}
