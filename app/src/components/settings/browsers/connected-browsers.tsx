import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { revokeRecorderConnectionMutationOptions } from "@/lib/recorder/mutations";
import { recorderConnectionsQueryOptions } from "@/lib/recorder/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** The browsers signed in to this OpenBot as you, each with a Disconnect that revokes its sign-in. */
export function ConnectedBrowsers() {
  const connections = useQuery(recorderConnectionsQueryOptions());
  const revoke = useMutation(
    revokeRecorderConnectionMutationOptions(queryClient),
  );
  return (
    <PageSection title="Connected browsers">
      {connections.isPending ? null : connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          Could not load connected browsers.
        </p>
      ) : connections.data.connections.length === 0 ? (
        <PageEmpty>No browsers are connected.</PageEmpty>
      ) : (
        <PageRows>
          {connections.data.connections.map((connection, index) => (
            <div key={connection.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBrowser />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connection.label}</ItemTitle>
                  <ItemDescription>
                    Connected {relativeTime(connection.createdAt)} from{" "}
                    {connection.via === "desktop"
                      ? "OpenBot Desktop"
                      : "OpenBot"}
                    ,{" "}
                    {connection.lastUsedAt
                      ? `last used ${relativeTime(connection.lastUsedAt)}`
                      : "never used"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={`Disconnect ${connection.label}`}
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(connection.id)}
                  >
                    Disconnect
                  </Button>
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      )}
      {revoke.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {revoke.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
