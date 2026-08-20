import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back.
   *
   * It carries a server key on success and `failed` otherwise, and it is the only channel available:
   * the callback is a redirect from another company's server, so there is no response body to read.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    // The key is omitted rather than set to undefined. Present-but-undefined makes `search` a
    // required prop on every `Link to="/settings"` in the app, which is a lot of ripple for a
    // parameter only the OAuth callback ever sets.
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   */
  return (
    <PageShell
      description="How OpenBot looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Dark theme</ItemTitle>
              <ItemDescription>
                Use the dark appearance across OpenBot.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Dark theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <ConnectedAccounts />
    </PageShell>
  );
}

/**
 * The accounts this person has connected, and the ones they could.
 *
 * On this page rather than an admin one, which is the shape of the whole feature: an administrator
 * registers a connector once, and then each person grants access to their own documents. Nobody
 * sees anybody else's connections here, because there is no version of this list that is not
 * "yours".
 */
function ConnectedAccounts() {
  const { connected } = useSearch({ from: "/_authed/settings/" });
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  const connect = useMutation({
    mutationFn: async (serverId: string) => {
      const response = await fetch(`/api/plugins/servers/${serverId}/connect`, {
        method: "POST",
        credentials: "include",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "This could not be connected.");
      }
      /*
       * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
       * shown to the person in their own browser — there is nothing here that could complete it on
       * their behalf, which is the point.
       */
      window.location.href = body.authorizationUrl;
    },
  });

  /** Only the vendors reached as an individual. Everything else is the deployment's own credential. */
  const connectable = (plugins.data?.catalogue ?? []).filter(
    (item) =>
      item.auth === "user-oauth" &&
      plugins.data?.servers.some((server) => server.id === item.key),
  );

  const held = new Map(
    (connections.data?.connections ?? []).map((row) => [row.serverId, row]),
  );

  return (
    <PageSection
      description="Services a Bot reads as you, so it only ever sees what you can see. Connecting is yours to grant and yours to withdraw."
      title="Your connected accounts"
    >
      {connected === "failed" ? (
        <p className="mb-3 text-destructive text-sm" role="alert">
          That account could not be connected. Nothing was saved — try again.
        </p>
      ) : null}
      {connect.error ? (
        <p className="mb-3 text-destructive text-sm" role="alert">
          {connect.error.message}
        </p>
      ) : null}
      {plugins.isPending || connections.isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : connectable.length === 0 ? (
        <PageEmpty>
          Nothing here yet. An administrator adds these on the Plugins page, and
          they appear for you to connect.
        </PageEmpty>
      ) : (
        <PageRows>
          {connectable.map((item) => {
            const connection = held.get(item.key);
            return (
              <Item key={item.key} size="sm">
                <ItemContent>
                  <ItemTitle>{item.title}</ItemTitle>
                  <ItemDescription>
                    {connection
                      ? `Connected ${new Date(connection.connectedAt).toLocaleDateString()}.`
                      : item.summary}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={connect.isPending}
                    onClick={() => connect.mutate(item.key)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {connection ? "Reconnect" : "Connect"}
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}
