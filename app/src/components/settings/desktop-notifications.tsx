import { useState } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  type DesktopPermission,
  parseDesktopNotificationsPreference,
  requestDesktopNotifications,
} from "@/lib/notifications/desktop";

/**
 * The switch that asks the browser for permission, and the only thing in the product that does.
 *
 * Turning it on is the whole consent. Nothing on load asks, nothing on a first notification asks,
 * and a person who never opens this page is never prompted — which is the point, because a prompt
 * shown before somebody knows what it is for is usually answered with Block, and Block is close
 * enough to permanent that the feature is then gone.
 *
 * The switch refuses to sit at "on" when the browser has said no. A control that reports a state the
 * product cannot deliver is worse than one that is off: somebody would rely on it and miss the Bot
 * that was waiting for them.
 */
export function DesktopNotificationsSetting() {
  const [enabled, setEnabled] = useState(() => storedPreference());
  const [refusal, setRefusal] = useState<DesktopPermission | null>(null);

  const change = async (wanted: boolean) => {
    if (!wanted) {
      setRefusal(null);
      store(false);
      setEnabled(false);
      return;
    }

    const answer = await requestDesktopNotifications();
    if (answer !== "granted") {
      setRefusal(answer);
      store(false);
      setEnabled(false);
      return;
    }
    setRefusal(null);
    store(true);
    setEnabled(true);
  };

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>Desktop notifications</ItemTitle>
        <ItemDescription>
          Tell me when one of my Bots has stopped and is waiting for me, even
          when OpenBot is not the window I am looking at.
          {refusal === "denied" ? (
            <span className="mt-1 block">
              This browser is blocking notifications from OpenBot. Allow them in
              its site settings and turn this on again.
            </span>
          ) : null}
          {refusal === "unsupported" ? (
            <span className="mt-1 block">
              This browser does not support notifications. Bots that are waiting
              still show in the sidebar.
            </span>
          ) : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label="Desktop notifications"
          checked={enabled}
          onCheckedChange={(wanted) => void change(wanted)}
        />
      </ItemActions>
    </Item>
  );
}

/*
 * Storage failures are swallowed on both sides.
 *
 * A browser with storage blocked keeps the preference for this tab and forgets it on reload, which
 * is a smaller loss than a settings page that throws while somebody is reading it.
 */
function storedPreference(): boolean {
  try {
    return parseDesktopNotificationsPreference(
      window.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

function store(enabled: boolean) {
  try {
    window.localStorage.setItem(
      DESKTOP_NOTIFICATIONS_STORAGE_KEY,
      enabled ? "on" : "off",
    );
  } catch {
    // See above.
  }
}
