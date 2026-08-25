import {
  IconArrowUpRight,
  IconChevronRight,
  IconExternalLink,
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { storeMcpToken } from "@/lib/credentials/mutations";
import {
  addCuratedServerMutationOptions,
  connectAccountMutationOptions,
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

/** Which of the four dialogs is open, or none. */
type OpenDialog = "token" | "client" | "instance" | "grant" | null;

/** The set with one member toggled, as a new set so React sees the change. */
function toggled(
  set: ReadonlySet<string>,
  member: string,
): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
}

/**
 * How widely a tool is granted, in words rather than a fraction.
 *
 * "0/3" needs decoding and reads as a score. The two ends are the ones worth recognising without
 * reading — nothing holds this, or everything does — so they are named, and the middle is the only
 * case that gets a number.
 */
function grantSummary(held: number, total: number): string {
  if (held === 0) return "No Bots";
  if (held === total) return total === 1 ? "1 Bot" : "All Bots";
  return `${held} of ${total} Bots`;
}

function RouteComponent() {
  const { key } = useParams({ from: "/_authed/admin/plugins/$key" });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  /*
   * The administrator's OWN connections, not the deployment's.
   *
   * On an admin screen that is a deliberate mixture, and it is the useful one: setting a per-person
   * connector up and finding out whether it works are two different questions, and the second has no
   * answer anywhere on this page without it. Nobody else's connection is readable here — the endpoint
   * only ever returns the caller's, so this cannot become a list of who has connected what.
   */
  const connections = useQuery(connectionsQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const youConnected = (connections.data?.connections ?? []).some(
    (row) => row.serverId === key,
  );
  const nameFor = useBotNames();

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [token, setToken] = useState("");
  const [instanceHost, setInstanceHost] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  /** Who gets the tools, and which, while the grant dialog is open. */
  const [selectedBots, setSelectedBots] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedRefs, setSelectedRefs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [granting, setGranting] = useState(false);

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
  const connectSelf = useMutation({
    // Back to this page afterwards, not to the personal settings screen.
    ...connectAccountMutationOptions("admin"),
    ...report,
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (authorizationUrl) => {
      window.location.href = authorizationUrl;
    },
  });
  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = plugins.data?.servers.find((item) => item.id === key);
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

  /*
   * One write per grant, in selection order. The server records each grant as its own audit row, so
   * a bulk action here is honestly N decisions; a refusal stops the rest and leaves the dialog open
   * with the banner saying why.
   */
  const grantSelected = async () => {
    setError(null);
    setGranting(true);
    try {
      for (const agentId of selectedBots) {
        for (const ref of selectedRefs) {
          await setGrant.mutateAsync({
            agentId,
            granted: true,
            kind: "mcp",
            ref,
          });
        }
      }
      setDialog(null);
    } catch {
      /* Already in the banner via the mutation's own handler. */
    } finally {
      setGranting(false);
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

  /* The grant dialog's two halves of the tool list, split by what a boundary would see. */
  const reads = server?.tools.filter((tool) => tool.effect !== "write") ?? [];
  const writes = server?.tools.filter((tool) => tool.effect === "write") ?? [];
  const chosenWrites = writes.filter((tool) =>
    selectedRefs.has(tool.ref),
  ).length;
  const chosenNames = bots
    .filter((bot) => selectedBots.has(bot.id))
    .map((bot) => bot.name);

  return (
    <PageShell
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description={entry?.summary ?? server?.summary}
      title={title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {/*
       * No section heading. This is one decision, and a heading over a single row that repeats the
       * row's own title tells a reader nothing they cannot already see.
       */}
      <PageSection>
        <PageRows className="mt-0">
          {/*
           * Binary and immediate, which is what the layout skill reserves a Switch for: it takes
           * effect when switched and there is no save. It replaces an "Add to deployment" button and
           * a destructive "Remove" row that were the same decision drawn twice, in two places, one of
           * them looking far more dangerous than the other.
           *
           * The description states the consequence in the present tense, in both directions, because
           * switching this off deletes every grant on the vendor's tools and that is not recoverable
           * by switching it back on.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Enable for this deployment</ItemTitle>
              <ItemDescription>
                {server
                  ? "Bots may be granted its tools. Switching this off removes it and every grant on its tools."
                  : "No Bot can reach this vendor. Switch it on to configure it and grant its tools."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Enable ${title} for this deployment`}
                checked={server !== undefined}
                onCheckedChange={(next) => {
                  setError(null);
                  if (next) void add();
                  else remove.mutate(key);
                }}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {server ? (
        <PageSection
          description={
            auth === "user-oauth"
              ? "This vendor answers as whoever is asking. The deployment registers an OAuth client, and each person connects their own account, so a Bot only ever sees what that person can see."
              : "What this deployment presents to the vendor. One credential, used for everybody."
          }
          title="Connection"
        >
          {/*
           * Rows that DO something, and nothing else — with one admitted exception. The layout
           * skill's third row kind — a value with no chevron and nothing to click — earns its
           * place on a screen full of them, but among four actionable rows a dead one reads as a
           * control that has stopped working. The redirect URI is prose under the card instead.
           *
           * The exception is the OAuth client row for a vendor with a dynamic client: there is a
           * real fact to state — this deployment registers itself, nobody configures it — right
           * where the actionable client row would otherwise sit. Leaving that slot empty would
           * read as a missing setup step, not as nothing to do.
           */}
          <PageRows>
            {auth === "deployment-bearer" ? (
              <Item
                render={
                  <button onClick={() => setDialog("token")} type="button" />
                }
                size="sm"
              >
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

            {auth === "user-oauth" && server?.dynamicClient ? (
              /*
               * Nothing to click. This deployment registers its own OAuth client with the
               * vendor (RFC 7591) the first time anybody connects, so there is no client id
               * or secret for an administrator to hold, let alone paste.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>OAuth client</ItemTitle>
                  <ItemDescription>
                    This deployment registers itself with the vendor on first
                    connect. There is nothing to paste.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    Self-registered
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && !server?.dynamicClient ? (
              <Item
                render={
                  <button onClick={() => setDialog("client")} type="button" />
                }
                size="sm"
              >
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
            ) : null}

            {/*
             * The administrator's own account, on the setup screen.
             *
             * Setting a connector up and knowing whether it works are different questions, and the
             * second used to have no answer here: an administrator finished configuring Drive and
             * had to go to their personal settings to find out whether any of it was right. This row
             * answers it in place, and stays honest about being personal — it is this person's
             * connection, not deployment state, and it reaches their documents and nobody else's.
             *
             * It is NOT part of setup. The connector is fully configured without it, which is why it
             * sits below the client and says so rather than reading as the next required step.
             *
             * Shown once a client exists, because there is nothing to consent against before
             * that: a Connect button with no OAuth client behind it can only fail. A vendor with a
             * dynamic client is the exception — there is no client to register in advance, so
             * Connect is shown right away and is itself what creates one.
             */}
            {auth === "user-oauth" &&
            (server?.hasCredential || server?.dynamicClient) ? (
              <>
                <Separator />
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>Your account</ItemTitle>
                    <ItemDescription>
                      {youConnected
                        ? `Connected, so a Bot granted these tools uses your ${title} as you. Everybody else connects their own.`
                        : "Connect your own account to try this connector. Setup is complete without it, and it reaches your documents only."}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {youConnected ? (
                      <>
                        {/* Decorative: the word beside it already says which. */}
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        <span className="text-muted-foreground text-xs">
                          Connected
                        </span>
                      </>
                    ) : (
                      /* The arrow says this leaves OpenBot for the vendor's consent page. It does. */
                      <Button
                        disabled={connectSelf.isPending}
                        onClick={() => {
                          setError(null);
                          connectSelf.mutate(key);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Connect
                        <IconArrowUpRight />
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              </>
            ) : null}

            {entry?.perInstance ? (
              <>
                <Separator />
                <Item
                  render={
                    <button
                      onClick={() => setDialog("instance")}
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>Instance host</ItemTitle>
                    <ItemDescription>
                      This vendor gives every customer their own hostname,
                      checked against its pattern before anything is stored.
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

          {auth === "user-oauth" ? (
            <div className="mt-3 p-3">
              {server?.dynamicClient ? (
                <p className="text-muted-foreground text-sm">
                  The deployment registers its redirect URI itself, so there is
                  nothing to add at the vendor.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Add this to the client's authorised redirect URIs at the
                  vendor, exactly as written. A single wrong character fails
                  there, with a message that does not mention OpenBot.
                </p>
              )}
              {!plugins.data?.redirectUri ? (
                <p className="mt-3 text-destructive text-sm" role="alert">
                  This deployment has no public URL, so nobody can complete a
                  consent flow. Set OPENBOT_PUBLIC_URL.
                </p>
              ) : server?.dynamicClient ? null : (
                /* Selectable and monospaced: it is copied by hand into somebody else's console. */
                <code className="mt-3 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {plugins.data.redirectUri}
                </code>
              )}
            </div>
          ) : null}
        </PageSection>
      ) : null}

      {server ? (
        <PageSection
          /*
           * Beside the heading rather than on the page's own baseline. Refreshing is about this list
           * and nothing else on the screen — it asks the vendor what it offers now — so it belongs
           * where the list is named. Ghost, because it is a maintenance action rather than the thing
           * an administrator came here to do.
           */
          action={
            <div className="flex gap-1.5">
              <Button
                onClick={() => refresh.mutate(key)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Refresh tools
              </Button>
              {/*
               * Outline where refresh is ghost: granting is the thing an administrator came to
               * this section to do. Hidden rather than disabled with nothing to grant — a dialog
               * over an empty list could only explain its own emptiness.
               */}
              {server.tools.length > 0 && bots.length > 0 ? (
                <Button
                  onClick={() => {
                    setSelectedBots(new Set());
                    setSelectedRefs(new Set());
                    setDialog("grant");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Grant tools…
                </Button>
              ) : null}
            </div>
          }
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
                  {/* A real link with no children: children passed to `render` replace the row's own. */}
                  <Item
                    render={
                      <Link
                        params={{ key, tool: tool.name }}
                        to="/admin/plugins/$key/tools/$tool"
                      />
                    }
                    size="sm"
                  >
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">
                        {tool.name}
                      </ItemTitle>
                      <ItemDescription>{tool.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * How many Bots hold it, not which. The names were here as a chip each and
                       * turned every row into a wrapping cluster of controls — twenty-four of them
                       * across this list — with the tool's own name losing the fight for attention.
                       * A count is what a reader scanning for "what is exposed, and how widely" is
                       * actually asking, and the names are one click away where they can be switched
                       * one at a time.
                       */}
                      <span className="text-muted-foreground text-xs">
                        {grantSummary(tool.grantedTo.length, bots.length)}
                      </span>
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
                      <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                  {index !== server.tools.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}
        </PageSection>
      ) : null}

      {/*
       * Only when there is something to say. An empty section here would teach a reader to scroll past
       * a heading that is usually blank, which is the opposite of the point.
       *
       * Its own section rather than rows inside Tools, because these are not tools: they are not
       * listed by the vendor, there is no page to open for one, and putting them in the same list
       * would make the count above it wrong.
       */}
      {server && server.withdrawn.length > 0 ? (
        <PageSection
          description="This vendor no longer lists these, so no Bot is told about them and no model can call one. The grant is still recorded, and the tool would be offered again if the vendor started listing it. Revoke from the Bot's own page if that is not what you want."
          title="Held but not offered"
        >
          <PageRows>
            {server.withdrawn.map((held, index) => (
              <React.Fragment key={held.ref}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs">
                      {held.name}
                    </ItemTitle>
                    <ItemDescription>
                      Not listed by {title}
                      {server.toolsRefreshedAt ? ` as of the last refresh` : ""}
                      .
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {grantSummary(held.grantedTo.length, bots.length)}
                    </span>
                  </ItemActions>
                </Item>
                {index !== server.withdrawn.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <Dialog
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        open={dialog !== null && dialog !== "grant"}
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

      {/*
       * Who first, then what: the decision arrives as "set this Bot up", not as a list of tools
       * looking for an owner. Both groups get a select-all; the amber heading and the footer's
       * "N of which change things" are what keep a bulk write grant a read decision, not a blind one.
       */}
      {server ? (
        <Dialog
          onOpenChange={(open) => setDialog(open ? dialog : null)}
          open={dialog === "grant"}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Grant tools</DialogTitle>
              <DialogDescription>
                Each grant is its own entry on the audit trail, and a granted
                write is still checked against the boundaries on every call.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 space-y-5">
              <div>
                <p className="mb-2 font-medium text-sm">To</p>
                <div className="space-y-2">
                  {bots.map((bot) => (
                    <label
                      className="flex items-center gap-2 text-sm"
                      key={bot.id}
                    >
                      <Checkbox
                        checked={selectedBots.has(bot.id)}
                        onCheckedChange={() =>
                          setSelectedBots((previous) =>
                            toggled(previous, bot.id),
                          )
                        }
                      />
                      {bot.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="max-h-64 space-y-5 overflow-y-auto">
                {reads.length > 0 ? (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="font-medium text-sm">Reads</p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of reads) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Select all
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {reads.map((tool) => (
                        <label
                          className="flex items-center gap-2"
                          key={tool.ref}
                        >
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <span className="font-mono text-xs">{tool.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                {writes.length > 0 ? (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="font-medium text-amber-600 text-sm dark:text-amber-500">
                        Changes things
                      </p>
                      <Button
                        onClick={() =>
                          setSelectedRefs((previous) => {
                            const next = new Set(previous);
                            for (const tool of writes) next.add(tool.ref);
                            return next;
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Select all
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {writes.map((tool) => (
                        <label
                          className="flex items-center gap-2"
                          key={tool.ref}
                        >
                          <Checkbox
                            checked={selectedRefs.has(tool.ref)}
                            onCheckedChange={() =>
                              setSelectedRefs((previous) =>
                                toggled(previous, tool.ref),
                              )
                            }
                          />
                          <span className="font-mono text-xs">{tool.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </DialogBody>
            <DialogFooter className="mt-4 items-center">
              {/* What is about to happen, in one sentence, before it does. */}
              {selectedRefs.size > 0 && chosenNames.length > 0 ? (
                <p className="flex-1 text-muted-foreground text-xs">
                  {`Grant ${selectedRefs.size} ${
                    selectedRefs.size === 1 ? "tool" : "tools"
                  }${
                    chosenWrites > 0
                      ? `, ${chosenWrites} of which ${
                          chosenWrites === 1 ? "changes" : "change"
                        } things,`
                      : ""
                  } to ${chosenNames.join(", ")}.`}
                </p>
              ) : null}
              <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={
                  granting || selectedBots.size === 0 || selectedRefs.size === 0
                }
                onClick={() => void grantSelected()}
                size="sm"
              >
                Grant
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageShell>
  );
}
