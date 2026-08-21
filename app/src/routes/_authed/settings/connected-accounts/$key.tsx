import { IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({ component: RouteComponent });

function RouteComponent() {
  const { key } = useParams({
    from: "/_authed/settings/connected-accounts/$key",
  });
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (authorizationUrl) => {
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const enabled = (plugins.data?.servers ?? []).some((s) => s.id === key);
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );

  if (plugins.isPending) {
    return <PageShell title="Account">{null}</PageShell>;
  }

  const back = {
    label: "Connected accounts",
    linkProps: { to: "/settings/connected-accounts" as const },
  };

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="This is not a service you connect for yourself."
        title={entry?.title ?? key}
      >
        <PageEmpty>
          {entry
            ? "A Bot reaches this one with a credential the deployment holds, the same for everybody."
            : "This deployment has no connector by that name."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Connect your account</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "An administrator has not enabled this connector, so there is nothing to connect to yet."
                  : connection
                    ? "A Bot granted its tools reads this as you, and sees only what you can see."
                    : "No Bot can read this as you. Switching this on sends you to the vendor to consent."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Connect your ${entry.title} account`}
                checked={connection !== undefined}
                disabled={!enabled || connect.isPending}
                onCheckedChange={(next) => {
                  setNotice(null);
                  if (next) {
                    connect.mutate(key);
                    return;
                  }
                  /*
                   * NOT BUILT YET, and it says so rather than doing nothing.
                   *
                   * Withdrawing is a real act with three parts — revoke at the vendor, revoke the
                   * vault credential, delete the row — and none of them exist. A switch that moved
                   * and changed nothing would be worse than one that refuses: it would report that
                   * access had been withdrawn when it had not.
                   */
                  setNotice(
                    "Withdrawing access is not built yet. Until it is, revoke it in your Google account's third-party access settings — that stops the deployment reading your Drive immediately.",
                  );
                }}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description="What you agreed to, as the vendor recorded it — not what was asked for. The two differ when a consent screen is only partly accepted."
          title="Access"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Granted</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "The vendor named no scope."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Connected</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}

      {entry.docsUrl ? (
        <PageSection>
          <PageRows>
            <Item
              render={
                <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
              }
              size="sm"
            >
              <ItemContent>
                <ItemTitle>Vendor documentation</ItemTitle>
                <ItemDescription>
                  What this service offers, from the people who maintain it.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
