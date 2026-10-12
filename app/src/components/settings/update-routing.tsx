import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { deliveryQueryOptions } from "@/lib/delivery";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "Progress",
    description: "Replies and results from work you were not watching.",
  },
  decision: {
    title: "Decisions",
    description: "Approvals a Bot needs before it acts.",
  },
  question: {
    title: "Questions",
    description: "Things a Bot asked you and is waiting on.",
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
   * A channel this deployment has not set up can carry nothing, so its switch is off and disabled
   * whatever the stored preference says, rather than on beside a channel that delivers nothing. The
   * preference itself is left alone: an administrator who configures Slack later finds it as the
   * person last set it. When the deployment's channels could not be read, the preference is shown
   * as it is rather than every channel claimed unavailable.
   */
  const configured = (transport: UpdateTransport) =>
    reach.data ? reach.data.available[transport] : true;
  return (
    <PageSection
      description="Where each kind of update goes when you are not looking. The web always shows everything."
      title="Where updates go"
    >
      {routing.isPending || reach.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Could not load where your updates go.
        </p>
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
                    {TRANSPORTS.map((transport) => (
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
                        <span className="flex flex-col leading-tight whitespace-nowrap">
                          {transport.label}
                          {configured(transport.id) ? null : (
                            <span className="text-muted-foreground text-xs">
                              Not set up
                            </span>
                          )}
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
