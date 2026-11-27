import { IconBell } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { failureSaid } from "@/lib/load-failure";
import { webPushSupport } from "@/lib/web-push/browser";
import { NOT_ALLOWED } from "@/lib/web-push/mutations";
import { useNotificationsOffer } from "./use-notifications-offer";
import { HOME_SCREEN_FIRST, NEWER_IOS_FIRST } from "./web-push-words";

/**
 * A Bot's page's offer to turn notifications on, a row in its card with the separator above it:
 * Turn on does what Settings' "Notifications in this browser" does (`useNotificationsOffer`). On an
 * iPhone or iPad, the sentence that says what to do first instead of a button that can't work.
 * Nothing once they are on, or where the browser blocks them or can't show any.
 */
export function NotificationsOfferRow() {
  const { offer, turnOn, pending, error } = useNotificationsOffer();
  if (offer === null) return null;
  const failed = error && error.message !== NOT_ALLOWED ? error : null;
  const said =
    offer === "home-screen-first"
      ? HOME_SCREEN_FIRST
      : offer === "newer-ios-first"
        ? NEWER_IOS_FIRST
        : webPushSupport() === "supported"
          ? "Off in this browser. Turn them on to hear when a Bot needs you, even when OpenBot is closed."
          : "Off in this browser. Turn them on to hear when a Bot needs you.";
  return (
    <>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconBell />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Browser notifications</ItemTitle>
          {/* Whole on a phone too: clamped, the sentence lost what it was for. */}
          <ItemDescription className="line-clamp-none">{said}</ItemDescription>
          {failed ? (
            <p className="text-destructive text-sm" role="alert">
              {failureSaid(failed)}
            </p>
          ) : null}
        </ItemContent>
        {offer === "button" ? (
          <ItemActions>
            <Button
              disabled={pending}
              onClick={() => turnOn()}
              size="sm"
              variant="outline"
            >
              Turn on
            </Button>
          </ItemActions>
        ) : null}
      </Item>
    </>
  );
}
