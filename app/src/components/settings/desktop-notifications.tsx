import { useEffect, useState } from "react";
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
  type DesktopNotificationsState,
  parseDesktopNotificationsPreference,
  reconcileDesktopNotifications,
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
 * that was waiting for them. So what was stored is settled against the live permission every time
 * this is shown, and again whenever the tab is looked at, because revoking a grant is done in the
 * browser's own settings and the way back from there is to this tab.
 */
export function DesktopNotificationsSetting() {
  const [state, setState] = useState<DesktopNotificationsState>(() =>
    reconcileDesktopNotifications(storedPreference()),
  );

  useEffect(() => {
    const settle = () => {
      const stored = storedPreference();
      const next = reconcileDesktopNotifications(stored);
      // Written back, not merely displayed. Everything else in the product reads the stored value
      // and would go on reading a yes this browser has withdrawn.
      if (stored && !next.enabled) store(false);
      setState(next);
    };

    settle();
    window.addEventListener("focus", settle);
    return () => window.removeEventListener("focus", settle);
  }, []);

  const change = async (wanted: boolean) => {
    if (!wanted) {
      store(false);
      setState({ enabled: false, withdrawn: null });
      return;
    }

    const answer = await requestDesktopNotifications();
    if (answer !== "granted") {
      store(false);
      setState({ enabled: false, withdrawn: answer });
      return;
    }
    store(true);
    setState({ enabled: true, withdrawn: null });
  };

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>Desktop notifications</ItemTitle>
        <ItemDescription>
          Tell me when one of my Bots has stopped and is waiting for me, even
          when OpenBot is not the window I am looking at.
          {state.withdrawn === "denied" ? (
            <span className="mt-1 block">
              This browser is blocking notifications from OpenBot. Allow them in
              its site settings and turn this on again.
            </span>
          ) : null}
          {state.withdrawn === "unsupported" ? (
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
          checked={state.enabled}
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
