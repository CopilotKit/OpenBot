import { IconCheck, IconPlug } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type AppAccess, botAppsQueryOptions } from "@/lib/app-access/queries";
import {
  confirmBrokeredConnectionMutationOptions,
  connectAccountMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import { queryClient } from "@/query-client";

/** An app this step left for, to be told about when the browser comes back. */
export type ConsentApp = { serverId: string; brokered: boolean };

/** Whether this row can be connected from here: the person's own account, through a sign-in page. */
function connectsHere(app: AppAccess): boolean {
  return (
    (app.state === "not_connected" || app.state === "reconnect") &&
    (app.connect === "oauth" || app.connect === "consent")
  );
}

/** What a row says under its name, or nothing when its button or its Connected says it all. */
function noteFor(app: AppAccess, botName: string): string | null {
  switch (app.state) {
    case "ready":
      return null;
    case "not_connected":
    case "reconnect":
      if (!connectsHere(app)) return "Connect it later in Connections.";
      return app.state === "reconnect" ? "Needs reconnecting." : null;
    case "owner_grantable":
      return "You can give it to a Bot later from the Bot's page.";
    case "not_granted":
      return `${botName} can't use it yet. An admin can give it.`;
    case "disabled":
      return "Not set up yet. An admin has to turn it on.";
    case "shared_not_connected":
    case "shared_not_approved":
      return "An admin connects this one for everybody.";
  }
}

/**
 * Onboarding's Connect your apps step: the apps a Bot uses as you, one row each, and Connect on the
 * ones you can connect here and now.
 *
 * WHAT A ROW SAYS IS THE SERVER'S. It is the app-access state for this person on their default Bot
 * (`GET /api/plugins/for/:agentId/apps`), the same answer the chat card and Connections draw, so a
 * row never reads Connected while the Bot cannot use the app. Only apps that run on the person's own
 * account are listed: a team account is an admin's to connect.
 *
 * CONNECT LEAVES AND COMES BACK HERE. An app with a sign-in page leaves for it with
 * `returnTo=onboarding`, and both outcomes land on this step again (`/onboarding?step=apps`). An app
 * whose key somebody types is connected in Connections, where its form is, and says so. A brokered
 * consent proves nothing by coming back, so the app this tab left for (`returned`) is asked of the
 * vendor on arrival, as the account page does, and the row turns Connected only on its answer. An
 * account the vendor already held is recorded on the press, with nowhere to leave for.
 */
export function ConnectAppsStep({
  failed,
  returned,
  leaveFor,
}: {
  /** The last consent came back failed. */
  failed: boolean;
  /** The app the last consent was for, when this tab is coming back from it. */
  returned?: ConsentApp | null;
  /** Where the browser goes to approve the connection: the vendor's own page. */
  leaveFor: (url: string, app: ConsentApp) => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const bot = defaultAgentProfile(agents.data);
  const apps = useQuery({
    ...botAppsQueryOptions(bot?.id ?? ""),
    enabled: bot !== undefined,
  });
  const rows = apps.data?.filter((app) => app.account === "personal");
  const nameOf = (serverId: string | undefined) =>
    apps.data?.find((app) => app.key === serverId)?.displayName;

  const [problem, setProblem] = useState<string | null>(null);
  const connect = useMutation({
    ...connectAccountMutationOptions("onboarding"),
    onError: (error: Error) => setProblem(error.message),
    onSuccess: (start, serverId) => {
      const app = apps.data?.find((candidate) => candidate.key === serverId);
      if (start !== null && "connected" in start) {
        // The vendor already held this account, and the press recorded it: nothing to leave for.
        void invalidatePlugins(queryClient);
        return;
      }
      if (start === null) {
        setProblem(
          `${app?.displayName ?? "This app"} connects with a key. Connect it in Connections when you're done here.`,
        );
        return;
      }
      leaveFor(start.authorizationUrl, {
        serverId,
        brokered: app?.connect === "consent",
      });
    },
  });

  /*
   * Back from a brokered consent: ask the vendor, once. The confirmation refreshes the rows itself,
   * so the row reads what the server now says, and a "not connected" is said on the step.
   */
  const confirm = useMutation(
    confirmBrokeredConnectionMutationOptions(queryClient),
  );
  const { mutate: confirmAccount } = confirm;
  const asked = useRef(false);
  useEffect(() => {
    if (!returned?.brokered || asked.current) return;
    asked.current = true;
    confirmAccount(returned.serverId);
  }, [returned, confirmAccount]);

  const returnedName = nameOf(returned?.serverId) ?? "that app";
  const said =
    problem ??
    (failed || confirm.data?.connected === false
      ? `Couldn't connect ${returnedName}. Try again.`
      : confirm.error
        ? `Couldn't check ${returnedName}. Look in Connections once you're done here.`
        : null);

  return (
    <div className="flex w-full flex-col" data-connect-apps="">
      {said ? (
        <p className="type-sub text-destructive" role="alert">
          {said}
        </p>
      ) : null}
      {agents.isPending ||
      (bot !== undefined && apps.isPending) ? null : apps.error ||
        agents.error ||
        bot === undefined ? (
        <p className="type-sub mt-4 text-destructive" role="alert">
          Couldn't load your apps. Continue, and connect them later in
          Connections.
        </p>
      ) : rows?.length === 0 ? (
        <PageEmpty icon={IconPlug} title="No apps to connect yet">
          When an admin adds apps, you can connect them in Connections.
        </PageEmpty>
      ) : (
        <PageRows>
          <ul aria-label="Apps">
            {rows?.map((app, at) => (
              <li data-app-row={app.key} data-state={app.state} key={app.key}>
                {at > 0 ? <Separator /> : null}
                <AppRow
                  app={app}
                  botName={bot?.name ?? "Your Bot"}
                  busy={connect.isPending}
                  checking={confirm.isPending && returned?.serverId === app.key}
                  connecting={
                    connect.isPending && connect.variables === app.key
                  }
                  onConnect={() => {
                    setProblem(null);
                    connect.mutate(app.key);
                  }}
                />
              </li>
            ))}
          </ul>
        </PageRows>
      )}
    </div>
  );
}

/** One app: its mark, its name, and Connected, Connect, or why neither. */
function AppRow({
  app,
  botName,
  busy,
  connecting,
  checking,
  onConnect,
}: {
  app: AppAccess;
  botName: string;
  busy: boolean;
  connecting: boolean;
  checking: boolean;
  onConnect: () => void;
}) {
  const note = noteFor(app, botName);
  return (
    <Item size="sm">
      <RowMark className="size-9">
        <PluginLogo logo={app.logo} />
      </RowMark>
      <ItemContent className="min-w-0">
        <ItemTitle>{app.displayName}</ItemTitle>
        {note ? <ItemDescription>{note}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="shrink-0">
        {checking ? (
          <span className="type-caption text-muted-foreground">Checking…</span>
        ) : app.state === "ready" ? (
          <span className="type-caption flex items-center gap-1 font-medium text-status-done">
            <IconCheck aria-hidden className="size-3.5" stroke={2.6} />
            Connected
          </span>
        ) : connectsHere(app) ? (
          <Button
            aria-label={`${app.state === "reconnect" ? "Reconnect" : "Connect"} ${app.displayName}`}
            disabled={busy}
            onClick={onConnect}
            size="sm"
            variant="outline"
          >
            {connecting
              ? "Connecting…"
              : app.state === "reconnect"
                ? "Reconnect"
                : "Connect"}
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  );
}
