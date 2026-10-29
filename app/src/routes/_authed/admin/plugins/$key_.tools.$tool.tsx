import { IconPlugOff, IconRobot, IconTool } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * One tool, and which Bots hold it.
 *
 * Its own screen because a grant is a per-Bot decision and there is no upper bound on Bots. The
 * connector page used to draw a chip for every Bot inside every tool row: at three Bots and eight
 * tools that is twenty-four controls stacked in a list, wrapping onto second and third lines, where
 * the thing being decided — does THIS Bot get THIS tool — was the least legible part of it. Here each
 * Bot is one row with one switch, which is the same decision with nothing competing for it.
 *
 * `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page rather
 * than becoming a layout with an outlet.
 */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/tools/$tool",
)({ component: RouteComponent });

function RouteComponent() {
  const { key, tool: toolName } = useParams({
    from: "/_authed/admin/plugins/$key_/tools/$tool",
  });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  /*
   * Whether a call from this Bot could be authenticated at all.
   *
   * Its own issued credential, or the deployment's shared one. Separate from the grant: the switch
   * decides whether the tool is offered to the model, this decides whether the call it makes gets
   * past the front door. A Bot with the grant and neither credential produced "May call this tool"
   * beside a tool that refused every call, with no audit row, because the call never arrived.
   */
  const sharedCallback = plugins.data?.botsMayCallBack === true;
  const canCallBack = (bot: { id: string }) =>
    sharedCallback ||
    [...(agents ?? []), ...(hiddenAgents ?? [])].find(
      (one) => one.id === bot.id,
    )?.hasCallbackToken === true;
  const [error, setError] = useState<string | null>(null);

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const server = plugins.data?.servers.find((row) => row.id === key);
  const tool = server?.tools.find((row) => row.name === toolName);

  const back = {
    label: server?.title ?? "Plugin",
    linkProps: {
      params: { key },
      to: "/admin/plugins/$key" as const,
    },
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title="Tool">{null}</PageShell>;
  }

  /*
   * A plugin list that could not be read is said as that, not as a connector that is not enabled:
   * `isPending` goes false on a failed fetch too, and the sentence below is a claim about this
   * deployment that a request that never came back is no evidence for. The per-Bot grant screen
   * keeps the same guard.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={toolName}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load plugins. Reload the page.
        </p>
      </PageShell>
    );
  }

  if (!tool) {
    return (
      <PageShell
        backButton={back}
        description="This connector has no tool with that name."
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty
          icon={server ? IconTool : IconPlugOff}
          title={server ? "Tool not found" : "This connector is off"}
        >
          {server
            ? "It may have been removed since the tool list was last refreshed."
            : "Turn it on to see its tools."}
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * Everybody on the roster, and anybody hidden from it who holds this tool: see `grantRoster`.
   * Named from the roster rows themselves, because the id-to-name lookup other admin screens use is
   * built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: tool.grantedTo,
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));

  return (
    <PageShell
      backButton={back}
      description={tool.description || "This tool has no description."}
      title={toolName}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          tool.effect === "write"
            ? "This tool changes something at the vendor. Boundaries about writes apply to it."
            : "This tool only reads. Boundaries about writes don't apply to it."
        }
        title="What it does"
      >
        <PageRows>
          {/*
           * Read-only, and the layout skill's third row kind is right here: there is one of it, it is
           * the fact the section exists to state, and nothing about it is switchable. The effect
           * comes from the vendor's own classification, not from the tool's name.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Effect</ItemTitle>
              <ItemDescription>
                Set by the connector, not the tool's name. Anything unknown
                counts as a write.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
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
        </PageRows>
      </PageSection>

      <PageSection
        description="A Bot can call this tool only while its switch is on. Turning it off applies from the next call."
        title="Bots"
      >
        {bots.length === 0 ? (
          <PageEmpty icon={IconRobot} title="No Bots yet">
            Create one to give it this tool.
          </PageEmpty>
        ) : (
          <PageRows>
            {bots.map((bot, index) => {
              const held = tool.grantedTo.includes(bot.id);
              return (
                <div key={bot.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{bot.name}</ItemTitle>
                      <ItemDescription>
                        {bot.hidden ? "Hidden from your roster. " : ""}
                        {held
                          ? canCallBack(bot)
                            ? "Can call this tool. Every call is still checked against boundaries and logged in Audit."
                            : "Allowed, but this Bot has no callback token. Every call is refused. Issue one on its page, or set AGENT_TOOL_TOKEN."
                          : "Can't call this tool. The Bot never sees it."}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Binary and immediate, which is what a Switch is for: it takes effect when
                       * switched and there is no save. Disabled only while its own write is in
                       * flight, so switching one Bot does not freeze the rest of the list.
                       */}
                      <Switch
                        aria-label={`Let ${bot.name} call ${toolName}`}
                        checked={held}
                        disabled={
                          setGrant.isPending &&
                          setGrant.variables?.agentId === bot.id
                        }
                        onCheckedChange={(next) => {
                          setError(null);
                          setGrant.mutate({
                            agentId: bot.id,
                            granted: next,
                            kind: "mcp",
                            ref: tool.ref,
                          });
                        }}
                      />
                    </ItemActions>
                  </Item>
                  {index !== bots.length - 1 && <Separator />}
                </div>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
