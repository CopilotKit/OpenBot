import { IconBell } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  HOME_SCREEN_FIRST,
  NEWER_IOS_FIRST,
} from "@/components/notifications/web-push-words";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { transportsQueryOptions } from "@/lib/delivery";
import { failureSaid } from "@/lib/load-failure";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { webPushSupport } from "@/lib/web-push/browser";
import {
  turnOffWebPushMutationOptions,
  turnOnWebPushMutationOptions,
} from "@/lib/web-push/mutations";
import { thisBrowserQueryOptions } from "@/lib/web-push/queries";
import { queryClient } from "@/query-client";

const TITLE = "Notifications in this browser";

/** What the row says, by where this browser stands. */
const SAID = {
  on: "Your Bots' updates show here, even when OpenBot is closed.",
  off: "Get your Bots' updates here, even when OpenBot is closed.",
  blocked:
    "Your browser blocks notifications from OpenBot. Allow them in your browser's settings for this site, then turn this on.",
  homeScreenFirst: HOME_SCREEN_FIRST,
  newerIosFirst: NEWER_IOS_FIRST,
} as const;

/**
 * Settings, Notifications: push notifications in the browser OpenBot is open in, so a Bot's reply,
 * question or approval reaches the person with OpenBot closed. Which kinds of update go out by push
 * is "Where updates go" above, the same for this browser as for a phone.
 *
 * One switch, which takes effect at once. Shown only where it can work: a browser with the Push API,
 * and an iPhone or iPad, where it says what to do first instead of a switch that would fail. Not in
 * OpenBot Desktop, which notifies through the desktop app, and not where OpenBot has no push to send.
 */
export function BrowserNotifications() {
  const support = webPushSupport();
  const permission = useNotificationPermission();
  const transports = useQuery(transportsQueryOptions());
  const browser = useQuery({
    ...thisBrowserQueryOptions(),
    enabled: support === "supported",
  });
  const turnOn = useMutation(turnOnWebPushMutationOptions(queryClient));
  const turnOff = useMutation(turnOffWebPushMutationOptions(queryClient));
  /*
   * Where the server says it has no push (an OpenBot that can't send any), there is nothing to turn
   * on. Not known yet, nothing; not readable, the row, which says so itself if turning it on fails.
   */
  if (
    support === "unsupported" ||
    transports.isPending ||
    transports.data?.push === false
  )
    return null;
  const blocked = support === "supported" && permission === "denied";
  const on = !blocked && browser.data?.on === true;
  const said =
    support === "home-screen-first"
      ? SAID.homeScreenFirst
      : support === "newer-ios-first"
        ? SAID.newerIosFirst
        : blocked
          ? SAID.blocked
          : on
            ? SAID.on
            : SAID.off;
  // The prompt's refusal is said by the row itself once the browser blocks them.
  const failed = blocked ? turnOff.error : (turnOn.error ?? turnOff.error);
  return (
    <PageSection title="This browser">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconBell />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{TITLE}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {said}
            </ItemDescription>
            {failed ? (
              <p className="text-destructive text-sm" role="alert">
                {failureSaid(failed)}
              </p>
            ) : null}
          </ItemContent>
          {support === "supported" ? (
            <ItemActions>
              <Switch
                aria-label={TITLE}
                checked={on}
                disabled={
                  blocked ||
                  browser.isPending ||
                  turnOn.isPending ||
                  turnOff.isPending
                }
                onCheckedChange={(checked) => {
                  if (checked) {
                    turnOff.reset();
                    // Asked here, in the press: Safari shows its prompt only from a tap.
                    turnOn.mutate(requestNotificationPermission());
                  } else {
                    turnOn.reset();
                    turnOff.mutate();
                  }
                }}
              />
            </ItemActions>
          ) : null}
        </Item>
      </PageRows>
    </PageSection>
  );
}
