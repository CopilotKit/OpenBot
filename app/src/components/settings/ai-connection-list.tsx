import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type AiConnectionOwner,
  connectionName,
  describeConnection,
} from "@/lib/ai-connection/describe";
import { useProviderPaths } from "@/lib/ai-connection/paths";
import { AI_PROVIDERS, providerById } from "@/lib/ai-connection/providers";
import type {
  AiConnectionEntry,
  AiConnections,
  ConnectionScope,
  PersonalAiConnection,
} from "@/lib/ai-connection/queries";
import { ProviderTile } from "./ai-connection-chooser";

/** What a section's description adds once it lists two or more connections. */
export const SEVERAL =
  "Your Bots can use any of these. Pick a model from any of them in a conversation.";

/**
 * The same, for the organization's on OpenBot Cloud: they are for whoever has none of their own,
 * and the reader's own Bots may run on theirs instead.
 */
export const SEVERAL_FOR_THE_ORGANIZATION =
  "Anyone who hasn't connected their own can pick a model from any of these in a conversation.";

/**
 * Several AI connections at once, as one row each in Settings → AI providers and Admin → AI providers:
 * the organization's (`organization`) or a person's own on OpenBot Cloud (`personal`). One per
 * provider. A run with no pick uses the default; a person picks a model from any of them in a
 * conversation.
 *
 * Each row is a link to the provider's own page (provider-pages.tsx), where it is made the default,
 * changed or disconnected. The last row links to the page that connects another AI. Connections
 * can be left with no default (the server picks one only when a removal leaves exactly one), and
 * then say so above the rows.
 *
 * The section around it reads the list (aiConnectionsQueryOptions) and draws the single
 * connection it drew before when the server is older than the list.
 */
export function AiConnectionRows({
  list,
  scope,
  organizationWide,
}: {
  list: AiConnections;
  scope: ConnectionScope;
  /** The organization's, beside each person's own (OpenBot Cloud). */
  organizationWide: boolean;
}) {
  const paths = useProviderPaths();
  const { connections } = list;
  const owner: AiConnectionOwner =
    scope === "organization" && organizationWide ? "organization" : "you";
  const several = connections.length > 1;
  const noDefault =
    connections.length > 0 && !connections.some((entry) => entry.isDefault);
  const unconnected = AI_PROVIDERS.filter(
    (provider) => !connections.some((entry) => entry.provider === provider.id),
  );
  return (
    <>
      {noDefault ? (
        <p className="mt-4 text-destructive text-sm" role="status">
          No default AI. Choose one so Bots can start work.
        </p>
      ) : null}
      <PageRows>
        {connections.map((entry, index) => (
          <Fragment key={entry.id}>
            {index > 0 ? <Separator /> : null}
            <ConnectionRow
              entry={entry}
              owner={owner}
              scope={scope}
              tagDefault={several}
            />
          </Fragment>
        ))}
        {unconnected.length > 0 ? (
          <>
            {connections.length > 0 ? <Separator /> : null}
            <Item render={<Link {...paths.connect(scope)} />} size="sm">
              <ItemMedia variant="icon">
                <IconPlus />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {connections.length > 0
                    ? "Connect another AI"
                    : scope === "personal"
                      ? "Connect your AI"
                      : "Connect an AI"}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
    </>
  );
}

function ConnectionRow({
  entry,
  owner,
  scope,
  tagDefault,
}: {
  entry: AiConnectionEntry;
  owner: AiConnectionOwner;
  scope: ConnectionScope;
  /** Two or more connections: the default says so. */
  tagDefault: boolean;
}) {
  const paths = useProviderPaths();
  const described = describeConnection(entry, owner);
  return (
    <Item render={<Link {...paths.provider(entry.id, scope)} />} size="sm">
      <ProviderTile provider={providerById(entry.provider)} />
      <ItemContent>
        <ItemTitle>
          {connectionName(entry)}
          {tagDefault && entry.isDefault ? (
            <span className="font-normal text-muted-foreground text-xs">
              Default
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {entry.ready ? (
            described?.summary
          ) : (
            <span className="text-destructive">{entry.problem?.detail}</span>
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * What happens when the last connection that can run goes, in the words the single connection's
 * dialogs used: a person's runs fall back to the organization's, an organization's on OpenBot
 * Cloud leaves only people with their own, and otherwise Bots can't run.
 */
export function lastGoes(
  scope: ConnectionScope,
  organizationWide: boolean,
  personal: PersonalAiConnection | null | undefined,
): string {
  if (scope === "personal")
    return personal?.organization.ready
      ? "Remove it and Bots use your organization's AI for you."
      : personal?.required
        ? "Remove it and Bots can't work for you until you connect another."
        : "Remove it and Bots stop using it for you.";
  return organizationWide
    ? "Disconnect it and Bots work only for people who connected their own AI."
    : "Disconnect it and Bots can't run until you connect another.";
}
