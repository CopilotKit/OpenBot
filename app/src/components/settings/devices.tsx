import { IconDeviceMobile, IconDevices, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  type Delivery,
  deliveriesQueryOptions,
  devicesQueryOptions,
  removePushDeviceMutationOptions,
} from "@/lib/delivery";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

const PLATFORM: Record<"ios" | "android", string> = {
  ios: "iOS",
  android: "Android",
};

/** Each channel as the switches under "Where updates go" name it. */
const CHANNEL: Record<Delivery["transport"], string> = {
  push: "Push",
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "SMS",
};

/**
 * What a delivery was about, as the kind of update it was routed under in "Where updates go", so a
 * row can be matched to the switch that let it through: a Bot's reply goes out as Progress, an
 * approval as a Decision, and a check-in ping as Something needs you.
 */
const KIND: Record<Delivery["kind"], string> = {
  reply: "Progress",
  approval: "Decision",
  question: "Question",
  attention: "Something needs you",
};

/**
 * Where a delivery got to. `accepted` is the provider taking it without saying yet that it arrived,
 * and `unknown` is a send that may or may not have gone; the error under the row says which.
 */
const STATE: Partial<Record<string, string>> = {
  queued: "Waiting to send",
  running: "Sending",
  accepted: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  unknown: "Not confirmed",
  opted_out: "Not sent",
};

/**
 * A delivery's line under its kind: how it went out, where it got to, and when. A state a newer
 * server sends that this app doesn't know is left out.
 */
export function deliveryLine(
  delivery: Pick<Delivery, "transport" | "state" | "createdAt">,
): string {
  return [
    CHANNEL[delivery.transport],
    STATE[delivery.state],
    new Date(delivery.createdAt).toLocaleString(),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The phones that receive push notifications for every one of the person's Bots. */
export function NativeDevices() {
  const devices = useQuery(devicesQueryOptions());
  const remove = useMutation(removePushDeviceMutationOptions(queryClient));
  const error = devices.error ?? remove.error;
  return (
    <PageSection
      description="Sign in to the OpenBot app on your phone and turn on notifications to add it here."
      title="Your devices"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(error)}
        </p>
      ) : null}
      {devices.isPending || !devices.data ? null : devices.data.length === 0 ? (
        <PageEmpty icon={IconDevices} title="No devices yet">
          Phones and computers you sign in on show up here.
        </PageEmpty>
      ) : (
        <PageRows>
          {devices.data.map((device, index) => (
            <Fragment key={device.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceMobile />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{PLATFORM[device.platform]}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(device.id)}
                    size="sm"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** What was sent to the person outside the web app, most recent first, with any failure. */
export function RecentDeliveries() {
  const deliveries = useQuery(deliveriesQueryOptions());
  return (
    <PageSection title="Recent deliveries">
      {deliveries.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(deliveries.error)}
        </p>
      ) : null}
      {deliveries.isPending || !deliveries.data ? null : deliveries.data
          .length === 0 ? (
        <PageEmpty icon={IconSend} title="No deliveries yet">
          Notifications sent to your devices show up here.
        </PageEmpty>
      ) : (
        <PageRows>
          {deliveries.data.map((delivery, index) => (
            <Fragment key={delivery.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSend />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{KIND[delivery.kind]}</ItemTitle>
                  <ItemDescription>{deliveryLine(delivery)}</ItemDescription>
                  {delivery.error ? (
                    <ItemDescription className="line-clamp-none text-destructive">
                      {delivery.error}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
