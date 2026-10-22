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

/** When a browser connected, to the minute: two copies with the same name (two Chrome profiles) stay told apart. */
const connectedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The browsers signed in to this OpenBot as you, each with a Disconnect that revokes its sign-in. The row of the copy
 * in this browser (`thisInstallId`, from This browser) says so. */
export function ConnectedBrowsers({
  thisInstallId,
}: {
  thisInstallId?: string;
} = {}) {
  const connections = useQuery(recorderConnectionsQueryOptions());
  const revoke = useMutation(
    revokeRecorderConnectionMutationOptions(queryClient),
  );
  return (
    <PageSection title="Connected browsers">
      {connections.isPending ? null : connections.error ? (
        <p className="text-destructive text-sm" role="alert">
          Couldn't load your connected browsers. Reload the page.
        </p>
      ) : connections.data.connections.length === 0 ? (
        <PageEmpty>No browsers connected yet.</PageEmpty>
      ) : (
        <PageRows>
          {connections.data.connections.map((connection, index) => {
            const here =
              thisInstallId !== undefined &&
              connection.installId === thisInstallId;
            const name = here
              ? `${connection.label} · This browser`
              : connection.label;
            return (
              <div key={connection.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBrowser />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{name}</ItemTitle>
                    <ItemDescription>
                      Connected{" "}
                      {connectedAt.format(new Date(connection.createdAt))} from{" "}
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
                      aria-label={`Disconnect ${name}`}
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
            );
          })}
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
