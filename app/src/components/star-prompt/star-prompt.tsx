import { STAR_ON_GITHUB } from "@openbot/shared/notices";
import { IconStar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import { type NudgeAction, noticeDue, recordNudge } from "@/lib/notices";
import {
  dismissNoticeMutationOptions,
  userPreferencesQueryOptions,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/** Where Star on GitHub goes. The repository's own page, which has the Star button. */
export const OPENBOT_REPO_URL = "https://github.com/CopilotKit/OpenBot";

/** What the card says. Exported for the tests, which read the words a person reads. */
export const STAR_ASK =
  "Enjoying OpenBot? Star it on GitHub so that we can keep making it better.";

/**
 * Drawn once in this page's life, until it is answered: a card the server said was due a moment
 * ago stays put when the moment passes, so it never vanishes from under somebody reading it. A
 * reload asks the server again.
 */
let drawnThisPage = false;
/** Its show is counted once per page. The server counts people, so a second page is no second person. */
let shownCounted = false;

/** For tests: a fresh page. */
export function forgetStarPrompt(): void {
  drawnThisPage = false;
  shownCounted = false;
}

/**
 * The ask to star OpenBot on GitHub, as a card above the message box. The same card as the
 * notifications offer, so it reads as part of the composer, and never a dialog.
 *
 * ONLY WHEN THE SERVER SAYS IT IS DUE. That is the personal edition (OpenBot for one person), never a
 * team's, for somebody who has used OpenBot on at least three days, right after a win: a copied
 * answer, a routine's run that finished, a long task that finished. Never after an error, and never
 * again once answered (shared/notices.ts). The browser only reads the answer: the edition from the
 * deployment, and `noticesDue` from the person's preferences, which `lib/notices.ts` reads again at
 * each moment that could make it due.
 *
 * READ FROM WHAT THE APP ALREADY LOADED, NEVER FETCHED FROM HERE. The self-host banner, mounted in
 * every page of the app, loads the person, the deployment and their preferences; this card only
 * watches those answers (`enabled: false` keeps an observer on the cache and sends nothing), so a
 * conversation does not grow requests of its own. Named query client: drawn inside the conversation,
 * whose components read no query context of their own (`voice-call-widget.tsx` names it the same way).
 */
export function StarPrompt() {
  const { data: capabilities } = useQuery(
    { ...deploymentCapabilitiesQueryOptions(), enabled: false },
    queryClient,
  );
  const userId = useQuery(
    { ...currentUserQueryOptions(), enabled: false },
    queryClient,
  ).data?.id;
  const { data: preferences } = useQuery(
    { ...userPreferencesQueryOptions(userId), enabled: false },
    queryClient,
  );
  const dismiss = useMutation(
    dismissNoticeMutationOptions(queryClient, userId),
    queryClient,
  );
  const answered = (preferences?.dismissedNotices ?? []).includes(
    STAR_ON_GITHUB,
  );
  const due =
    capabilities?.edition === "personal" &&
    noticeDue(preferences, STAR_ON_GITHUB);
  const [held, setHeld] = useState(drawnThisPage);
  const shown =
    capabilities?.edition === "personal" &&
    preferences !== undefined &&
    !answered &&
    (due || held);

  useEffect(() => {
    if (!shown) return;
    drawnThisPage = true;
    setHeld(true);
    if (shownCounted) return;
    shownCounted = true;
    void recordNudge(STAR_ON_GITHUB, "shown", "card");
  }, [shown]);

  if (!shown) return null;

  const respond = (action: NudgeAction) => {
    void recordNudge(STAR_ON_GITHUB, action, "card");
    drawnThisPage = false;
    setHeld(false);
    dismiss.mutate(STAR_ON_GITHUB);
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
        <ItemTitle className="text-pretty">{STAR_ASK}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button onClick={() => respond("dismissed")} size="sm" variant="ghost">
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
          onClick={() => respond("clicked")}
          rel="noopener noreferrer"
          target="_blank"
        >
          Star on GitHub
        </a>
      </ItemActions>
    </Item>
  );
}
