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
import { useBotNames } from "@/lib/agents/bot-names";
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
  const nameFor = useBotNames();
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

  if (!tool) {
    return (
      <PageShell
        backButton={back}
        description="This connector does not advertise a tool by that name."
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty>
          {server
            ? "It may have been withdrawn since the tool list was last refreshed."
            : "This deployment has not enabled that connector."}
        </PageEmpty>
      </PageShell>
    );
  }

  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));

  return (
    <PageShell
      backButton={back}
      description={tool.description || "This tool came with no description."}
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
            ? "This tool changes something at the vendor. A boundary written about writes applies to it, and it is refused when one matches."
            : "This tool only reads. A boundary written about writes does not apply to it."
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
                Decided by the connector, not by the tool's name. Anything
                unrecognised counts as a write.
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
        description="A Bot may call this tool only while its switch is on. Turning one off takes effect on the next call, with nothing cached in between."
        title="Bots"
      >
        {bots.length === 0 ? (
          <PageEmpty>
            This deployment has no Bots yet, so there is nobody to grant this
            to.
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
                        {held
                          ? "May call this tool. Every call is still checked against the boundaries and written to the audit trail."
                          : "Cannot call this tool. It is not offered to the model at all, so it has nothing to refuse."}
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
