import {
  IconBook,
  IconChevronRight,
  IconExternalLink,
  IconKey,
  IconServer,
  IconTool,
  IconTrash,
  IconUserCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { storeMcpToken } from "@/lib/credentials/mutations";
import {
  addCuratedServerMutationOptions,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One vendor: what it needs from this deployment, and which Bots hold its tools.
 *
 * Its own page because what a connector needs configured differs by vendor and does not fit on a
 * row. A token for one, an OAuth client and a redirect URI for another, an instance hostname for a
 * third, and then a grant per tool per Bot. The screen this replaced tried to hold all of that in a
 * list and grew a column per Bot, which is how a grant goes unread.
 */
export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
});

/** Which of the three shapes of edit a row opens, or none. */
type OpenDialog = "token" | "client" | "instance" | null;

function RouteComponent() {
  const { key } = useParams({ from: "/_authed/admin/plugins/$key" });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [token, setToken] = useState("");
  const [instanceHost, setInstanceHost] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });

  /* Every write reports into one banner rather than each growing its own handler. */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...report,
  });
  const registerClient = useMutation({
    ...registerOAuthClientMutationOptions(queryClient),
    ...report,
  });
  const refresh = useMutation({
    ...refreshPluginServerMutationOptions(queryClient),
    ...report,
  });
  const remove = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    ...report,
  });
  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    ...report,
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = plugins.data?.servers.find((item) => item.id === key);
  const youConnected = (connections.data?.connections ?? []).some(
    (row) => row.serverId === key,
  );
  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));

  /**
   * How this vendor is reached, from whichever record we have.
   *
   * A server added by URL has no catalogue entry, and nothing about it is reached as a person, so it
   * falls back to the shared-token shape.
   */
  const auth = entry?.auth ?? "deployment-bearer";
  const title = entry?.title ?? server?.title ?? key;

  /** Adding is two writes when a token was typed: the credential, then the record pointing at it. */
  const add = async () => {
    setError(null);
    try {
      const credentialId =
        auth === "deployment-bearer"
          ? await storeMcpToken(key, token || undefined)
          : undefined;
      await addCurated.mutateAsync({
        key,
        instanceHost: instanceHost || undefined,
        credentialId,
      });
      if (auth === "user-oauth" && client.clientId && client.clientSecret) {
        await registerClient.mutateAsync({ serverId: key, ...client });
      }
      setToken("");
      setClient({ clientId: "", clientSecret: "" });
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title="Plugin">{null}</PageShell>;
  }
  if (!(entry || server)) {
    return (
      <PageShell
        backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
        description="This deployment does not have a plugin by that name, and the catalogue does not offer one."
        title="Not a plugin"
      >
        <PageEmpty>Nothing to configure.</PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      action={
        server ? (
          <Button
            onClick={() => refresh.mutate(key)}
            size="lg"
            type="button"
            variant="outline"
          >
            Refresh tools
          </Button>
        ) : (
          <Button onClick={() => void add()} size="lg" type="button">
            Add to deployment
          </Button>
        )
      }
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description={entry?.summary ?? server?.summary}
      title={title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          auth === "user-oauth"
            ? "This vendor answers as whoever is asking. The deployment registers an OAuth client; everybody then connects their own account, so a Bot only ever sees what that person can see."
            : "What this deployment presents to the vendor. One credential, used for everybody."
        }
        title="Connection"
      >
        <PageRows>
          {auth === "deployment-bearer" ? (
            <Item
              render={
                <button onClick={() => setDialog("token")} type="button" />
              }
              size="sm"
            >
              <RowMark>
                <IconKey className="size-4" />
              </RowMark>
              <ItemContent>
                <ItemTitle>Access token</ItemTitle>
                <ItemDescription>
                  Sent as a bearer token on every call to this vendor.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {server?.hasCredential ? "Held" : "Not set"}
                </span>
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </ItemActions>
            </Item>
          ) : null}

          {auth === "user-oauth" ? (
            <>
              <Item
                render={
                  <button onClick={() => setDialog("client")} type="button" />
                }
                size="sm"
              >
                <RowMark>
                  <IconKey className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>OAuth client</ItemTitle>
                  <ItemDescription>
                    Identifies this deployment to the vendor. It reaches
                    nobody's documents on its own.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "Registered" : "Not registered"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
              <Separator />
              {/* Read-only: a value with no chevron, because there is nothing here to change. */}
              <Item size="sm">
                <RowMark>
                  <IconServer className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>Redirect URI</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    Add this to the client's authorised redirect URIs at the
                    vendor, exactly as written. A single wrong character fails
                    there, with a message that does not mention OpenBot.
                  </ItemDescription>
                  <ItemFooter>
                    {plugins.data?.redirectUri ? (
                      <code className="block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                        {plugins.data.redirectUri}
                      </code>
                    ) : (
                      <span className="text-destructive text-xs">
                        This deployment has no public URL, so nobody can
                        complete a consent flow. Set OPENBOT_PUBLIC_URL.
                      </span>
                    )}
                  </ItemFooter>
                </ItemContent>
              </Item>
              <Separator />
              <Item render={<Link to="/settings" />} size="sm">
                <RowMark>
                  <IconUserCheck className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>Your account</ItemTitle>
                  <ItemDescription>
                    Yours to grant and yours to withdraw, in Preferences. Nobody
                    can connect it for you.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {youConnected ? "Connected" : "Not connected"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}

          {entry?.perInstance ? (
            <>
              <Separator />
              <Item
                render={
                  <button onClick={() => setDialog("instance")} type="button" />
                }
                size="sm"
              >
                <RowMark>
                  <IconServer className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>Instance host</ItemTitle>
                  <ItemDescription>
                    This vendor gives every customer their own hostname, checked
                    against its pattern before anything is stored.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.url ?? "Not set"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}

          {entry?.docsUrl ? (
            <>
              <Separator />
              <Item
                render={
                  <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
                }
                size="sm"
              >
                <RowMark>
                  <IconBook className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>Vendor documentation</ItemTitle>
                  <ItemDescription>
                    What this server offers, from the people who maintain it.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>

      {server ? (
        <PageSection
          description="A Bot is told about a tool only when it holds it. Every call is decided again when it happens, so removing a grant takes effect on the next one."
          title="Tools"
        >
          {server.tools.length === 0 ? (
            <PageEmpty>
              {server.lastError ??
                "No tools listed. Refresh to ask the vendor again."}
            </PageEmpty>
          ) : (
            <PageRows>
              {server.tools.map((tool, index) => (
                <React.Fragment key={tool.ref}>
                  <Item size="sm">
                    <RowMark>
                      <IconTool className="size-4" />
                    </RowMark>
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">
                        {tool.name}
                      </ItemTitle>
                      <ItemDescription>{tool.description}</ItemDescription>
                      {/*
                       * The grants wrap onto their own line rather than sitting in ItemActions,
                       * which is where the layout skill puts a set: a chip per Bot would otherwise
                       * fight the tool name for horizontal space and start scrolling sideways.
                       */}
                      <ItemFooter>
                        <div className="flex flex-wrap gap-2">
                          {bots.map((bot) => {
                            const held = tool.grantedTo.includes(bot.id);
                            return (
                              <Button
                                key={bot.id}
                                onClick={() =>
                                  setGrant.mutate({
                                    agentId: bot.id,
                                    granted: !held,
                                    kind: "mcp",
                                    ref: tool.ref,
                                  })
                                }
                                size="sm"
                                type="button"
                                variant={held ? "default" : "outline"}
                              >
                                {bot.name}
                              </Button>
                            );
                          })}
                        </div>
                      </ItemFooter>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * The effect, not a description. It is what a boundary written about writes
                       * evaluates, and an operator writing that rule has no other way to know.
                       */}
                      <span
                        className={
                          tool.effect === "write"
                            ? "text-amber-600 text-xs dark:text-amber-500"
                            : "text-muted-foreground text-xs"
                        }
                      >
                        {tool.effect === "write" ? "changes things" : "reads"}
                      </span>
                    </ItemActions>
                  </Item>
                  {index !== server.tools.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}
        </PageSection>
      ) : null}

      {server ? (
        <PageSection title="Remove">
          <PageRows>
            <Item size="sm">
              <RowMark>
                <IconTrash className="size-4" />
              </RowMark>
              <ItemContent>
                <ItemTitle>Remove from this deployment</ItemTitle>
                <ItemDescription>
                  Every grant on its tools goes with it. Credentials stay in the
                  vault, revoked, so the trail still says what was held.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={() => remove.mutate(key)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  Remove
                </Button>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}

      <Dialog
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        open={dialog !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "client"
                ? `OAuth client for ${title}`
                : dialog === "instance"
                  ? `Instance host for ${title}`
                  : `Access token for ${title}`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "client"
                ? "From the vendor's console. The secret is stored in this deployment's vault and never read back."
                : dialog === "instance"
                  ? "Your own hostname with this vendor. It is checked against their pattern before anything is stored."
                  : "Stored in this deployment's vault and never read back."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              {dialog === "client" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="client-id">Client ID</FieldLabel>
                    <Input
                      id="client-id"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientId: event.target.value,
                        }))
                      }
                      value={client.clientId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="client-secret">
                      Client secret
                    </FieldLabel>
                    <Input
                      id="client-secret"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientSecret: event.target.value,
                        }))
                      }
                      type="password"
                      value={client.clientSecret}
                    />
                  </Field>
                </>
              ) : dialog === "instance" ? (
                <Field>
                  <FieldLabel htmlFor="instance-host">Instance host</FieldLabel>
                  <Input
                    id="instance-host"
                    onChange={(event) => setInstanceHost(event.target.value)}
                    placeholder="https://your-instance.service-now.com"
                    value={instanceHost}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="access-token">Access token</FieldLabel>
                  <Input
                    id="access-token"
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    value={token}
                  />
                </Field>
              )}
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!server) {
                  void add();
                  return;
                }
                if (dialog === "client") {
                  registerClient.mutate({ serverId: key, ...client });
                }
                setDialog(null);
              }}
              size="sm"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
