import { IconBell } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { failureSaid } from "@/lib/load-failure";
import { NOT_ALLOWED } from "@/lib/web-push/mutations";
import { useNotificationsOffer } from "./use-notifications-offer";
import { HOME_SCREEN_FIRST, NEWER_IOS_FIRST } from "./web-push-words";

/** Set once somebody answers the prompt either way, so it is offered once per browser. */
export const NOTIFY_PROMPT_KEY = "openbot-notify-prompt-answered";

/** Whether this browser has answered the offer, either way. The star prompt waits until it has. */
export function notifyPromptAnswered(): boolean {
  try {
    return localStorage.getItem(NOTIFY_PROMPT_KEY) !== null;
  } catch {
    // Storage refused: offer it, and the browser's own answer still hides it once given.
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(NOTIFY_PROMPT_KEY, new Date().toISOString());
  } catch {
    // Nothing to keep it in. The browser's answer hides it from now on anyway.
  }
}

/**
 * The offer to turn on notifications, made once the person's first task has started: the moment
 * a notification is plainly useful, because a Bot is now working on something for them.
 *
 * Enable notifications does what Settings' "Notifications in this browser" does
 * (`useNotificationsOffer`): the browser's permission and, where it has the Push API, this
 * browser's push subscription, so a Bot reaches the person with OpenBot closed.
 *
 * Shown until notifications are on, the browser blocks them, or the person answers. Not now hides it
 * in this browser, and so does a press, whatever the browser's prompt answered; a press that failed
 * for another reason says why and stays. A Bot's page and Settings still offer notifications
 * afterwards. On an iPhone or iPad, where a button can't work yet, it says what to do first, with
 * Not now beside it.
 */
export function NotifyPrompt() {
  const { offer, turnOn, pending, error } = useNotificationsOffer();
  const [dismissed, setDismissed] = useState(notifyPromptAnswered);
  if (offer === null || dismissed) return null;
  // A prompt closed or refused is an answer, said by hiding the offer, not as a failure.
  const failed = error && error.message !== NOT_ALLOWED ? error : null;
  const notNow = (
    <Button
      onClick={() => {
        remember();
        setDismissed(true);
      }}
      size="sm"
      variant="ghost"
    >
      Not now
    </Button>
  );

  return (
    <Item
      // The composer's own surface, so the card reads as part of it rather than see-through.
      className="mb-2 bg-card"
      data-notify-prompt=""
      size="sm"
      variant="outline"
    >
      <ItemMedia variant="icon">
        <IconBell />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="text-pretty">
          Get notified when your Bot finishes or needs your approval.
        </ItemTitle>
        {offer === "button" ? null : (
          <ItemDescription className="line-clamp-none">
            {offer === "home-screen-first"
              ? HOME_SCREEN_FIRST
              : NEWER_IOS_FIRST}
          </ItemDescription>
        )}
        {failed ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(failed)}
          </p>
        ) : null}
      </ItemContent>
      {offer === "button" ? (
        <ItemActions>
          {notNow}
          <Button
            disabled={pending}
            onClick={() => {
              remember();
              turnOn(({ failed }) => {
                // A prompt closed without an answer leaves the browser at "default": hide it anyway.
                if (!failed || failed.message === NOT_ALLOWED)
                  setDismissed(true);
              });
            }}
            size="sm"
            variant="outline"
          >
            Enable notifications
          </Button>
        </ItemActions>
      ) : (
        // Under the sentence, on a line of its own: beside it, Not now squeezed the sentence into
        // a narrow column on a phone.
        <ItemFooter>{notNow}</ItemFooter>
      )}
    </Item>
  );
}
