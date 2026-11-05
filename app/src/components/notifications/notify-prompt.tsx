import { IconBell } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";

/** Set once somebody answers the prompt either way, so it is offered once per browser. */
export const NOTIFY_PROMPT_KEY = "openbot-notify-prompt-answered";

function answered(): boolean {
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
 * Only while the browser has not been asked. A yes or a no in the browser's prompt hides it for
 * good, and Not now hides it in this browser. A Bot's page still offers notifications afterwards.
 */
export function NotifyPrompt() {
  const permission = useNotificationPermission();
  const [dismissed, setDismissed] = useState(answered);
  if (permission !== "default" || dismissed) return null;

  return (
    <Item className="mb-2" data-notify-prompt="" size="sm" variant="outline">
      <ItemMedia variant="icon">
        <IconBell />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="text-pretty">
          Get notified when your Bot finishes or needs your approval.
        </ItemTitle>
      </ItemContent>
      <ItemActions>
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
        <Button
          onClick={() => {
            remember();
            // A prompt closed without an answer leaves the browser at "default": hide it anyway.
            void requestNotificationPermission().then(() => setDismissed(true));
          }}
          size="sm"
          variant="outline"
        >
          Enable notifications
        </Button>
      </ItemActions>
    </Item>
  );
}
