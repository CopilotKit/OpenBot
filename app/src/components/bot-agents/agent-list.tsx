import { IconDots, IconPlus, IconSitemap } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { MetaTag } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deleteBotAgentMutationOptions } from "@/lib/bot-agents/mutations";
import {
  type AgentRecord,
  botAgentListQueryOptions,
  whereItRuns,
} from "@/lib/bot-agents/queries";
import { queryClient } from "@/query-client";
import { AgentCallbackToken } from "./agent-callback-token";
import { AgentMark } from "./agent-mark";

/** "Used by 2 Bots", or "Not used by any Bot yet". */
export function usedBy(count: number): string {
  if (count === 0) return "Not used by any Bot yet";
  return `Used by ${count} ${count === 1 ? "Bot" : "Bots"}`;
}

/**
 * Every agent the person's Bots may hand work to: OpenBot's own, and the ones the organization and
 * the person added. Each row says where it runs and how many Bots use it. Changing and deleting are
 * in the row's menu, for whoever may manage it; a key for calling tools back is offered on an agent
 * at its own address that OpenBot doesn't run.
 */
export function AgentList({
  onAdd,
  onEdit,
}: {
  onAdd: () => void;
  onEdit: (agent: AgentRecord) => void;
}) {
  const agents = useQuery(botAgentListQueryOptions());
  const remove = useMutation(deleteBotAgentMutationOptions(queryClient));
  const [refusal, setRefusal] = useState<{ id: string; message: string }>();
  const [keyFor, setKeyFor] = useState<string>();

  if (agents.isPending) return null;
  if (agents.data === undefined)
    return (
      <p className="text-destructive text-sm" role="alert">
        Couldn't load your agents. Try again in a moment.
      </p>
    );
  if (agents.data.length === 0)
    return (
      <PageSection>
        <PageEmpty
          action={
            <Button onClick={onAdd} size="sm" variant="outline">
              <IconPlus />
              Add agent
            </Button>
          }
          icon={IconSitemap}
          title="No agents yet"
        >
          Add an agent your Bots can hand work to.
        </PageEmpty>
      </PageSection>
    );

  return (
    <PageSection>
      <PageRows>
        {agents.data.map((agent, index) => (
          <Fragment key={agent.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <AgentMark agent={agent} />
              <ItemContent>
                <ItemTitle>{agent.name}</ItemTitle>
                <ItemDescription>{agent.description}</ItemDescription>
              </ItemContent>
              {agent.canManage ? (
                <ItemActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          aria-label={`More for ${agent.name}`}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <IconDots />
                        </Button>
                      }
                    />
                    <DropdownMenuContent>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => onEdit(agent)}>
                          Change
                        </DropdownMenuItem>
                        {agent.kind === "address" && !agent.builtIn ? (
                          <DropdownMenuItem
                            onClick={() =>
                              setKeyFor(
                                keyFor === agent.id ? undefined : agent.id,
                              )
                            }
                          >
                            Key for tools
                          </DropdownMenuItem>
                        ) : null}
                        {/* Immediate, with no undo, so it names the agent it deletes. */}
                        <DropdownMenuItem
                          onClick={() => {
                            setRefusal(undefined);
                            remove.mutate(agent.id, {
                              onError: (error) =>
                                setRefusal({
                                  id: agent.id,
                                  message: error.message,
                                }),
                            });
                          }}
                          variant="destructive"
                        >
                          Delete {agent.name}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              ) : null}
              <ItemFooter className="flex-wrap justify-start gap-x-3 gap-y-1 text-muted-foreground text-xs">
                <span>{whereItRuns(agent)}</span>
                <span>{usedBy(agent.botCount)}</span>
                {agent.visibility === "private" ? (
                  <MetaTag>Private</MetaTag>
                ) : null}
              </ItemFooter>
              {refusal?.id === agent.id ? (
                <ItemFooter>
                  <p className="text-destructive text-sm" role="alert">
                    {refusal.message}
                  </p>
                </ItemFooter>
              ) : null}
              {keyFor === agent.id ? (
                <ItemFooter>
                  <AgentCallbackToken agent={agent} />
                </ItemFooter>
              ) : null}
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
