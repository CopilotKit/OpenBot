import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { buttonVariants } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deliveryQueryOptions } from "@/lib/delivery";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { mayOpenSetup } from "@/lib/setup/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * How each channel is turned on: Slack and Teams through an OpenTag pairing, text messages through Twilio, push through
 * the OpenBot phone app. Each is a setting where OpenBot runs, read at start-up, so the docs say what to set; the two
 * sections sit together there. The setup checklist links the same page for Slack and Teams.
 */
export const CHANNEL_SETUP_DOCS =
  "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md#slack-and-microsoft-teams-opentag-pairing";

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "Progress",
    description: "Replies and results from work you weren't watching.",
  },
  decision: {
    title: "Decisions",
    description: "Approvals a Bot needs before it acts.",
  },
  question: {
    title: "Questions",
    description: "Things a Bot asked you and is waiting on.",
  },
  attention: {
    title: "Something needs you",
    description:
      "What your Bots' check-ins found, at most once an hour, every Bot in one message.",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "SMS" },
];

/**
 * Which channels each kind of update may use, for every one of the person's Bots at once. How much
 * a given Bot sends is that Bot's own Notifications setting, on its page.
 */
export function UpdateRoutingSection() {
  const routing = useQuery(updateRoutingQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  /*
   * Who can turn a channel on: an admin, or the one person running OpenBot themselves (the same rule as Settings,
   * Setup). They get the way to; anyone else is told it's their admin's to do.
   */
  const user = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const setsUp = mayOpenSetup(user.data, capabilities.data);
  /*
   * A channel this deployment has not set up can carry nothing, so its switch is off and disabled
   * whatever the stored preference says, rather than on beside a channel that delivers nothing. The
   * preference itself is left alone: an administrator who configures Slack later finds it as the
   * person last set it. When the deployment's channels could not be read, the preference is shown
   * as it is rather than every channel claimed unavailable.
   */
  const configured = (transport: UpdateTransport) =>
    reach.data ? reach.data.available[transport] : true;
  /*
   * Only the channels that can carry something get a switch. A channel that is not set up has nothing to choose, and
   * four rows of switches nobody can turn on said less than one sentence does. Its stored preference is kept as it is
   * and shows again once the channel is set up.
   */
  const shown = TRANSPORTS.filter((transport) => configured(transport.id));
  const choosing =
    !routing.isPending &&
    !reach.isPending &&
    !routing.error &&
    shown.length > 0;
  /*
   * OpenBot Desktop runs OpenBot on this computer, and every one of these channels needs OpenBot where the internet can
   * reach it (a phone, OpenTag, Twilio calling it). Its settings are the Desktop's own, so it gets no link to them.
   */
  const desktop = desktopShell() !== null;
  return (
    <PageSection
      // Said only above the switches: above the empty state it would point at nothing to choose.
      description={
        choosing
          ? "Choose where to receive each type of update when you’re away. All updates remain available in the web app."
          : undefined
      }
      title="Where updates go"
    >
      {routing.isPending || reach.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load where your updates go. Reload the page.
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty
          action={
            setsUp && !desktop ? (
              // An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link.
              <a
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                )}
                href={CHANNEL_SETUP_DOCS}
                rel="noopener noreferrer"
                target="_blank"
              >
                How to set them up
              </a>
            ) : undefined
          }
          icon={IconRoute}
          title="Updates stay in OpenBot"
        >
          {desktop
            ? "Push, Slack, Microsoft Teams and text messages need OpenBot running on a server."
            : setsUp
              ? "Push, Slack, Microsoft Teams and text messages show up here once they're set up where OpenBot runs."
              : "Push, Slack, Microsoft Teams and text messages show up here once your admin sets them up."}
        </PageEmpty>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                    <ItemDescription>
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="flex-wrap justify-start gap-x-6 gap-y-3 pl-8">
                    {shown.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={`${KIND_LABEL[kind].title} by ${transport.label}`}
                          checked={
                            configured(transport.id) && allowed(transport.id)
                          }
                          disabled={save.isPending || !configured(transport.id)}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        <span className="leading-tight whitespace-nowrap">
                          {transport.label}
                        </span>
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}
