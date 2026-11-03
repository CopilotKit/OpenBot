import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ManagedAgentConfig } from "../config";
import { type RegisteredAgent, registeredAgentFromRow } from "../copilot";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import { channelAgents, channelMemberships, channels } from "../db/schema";
import { botAccessFor } from "../team-bots/access";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import { bots } from "./bot-registry/directory";
import { isManagedEndpoint } from "./managed-endpoint";
import type { AgentActor } from "./profile-types";

/**
 * Read the agents one person may run, on every request.
 *
 * From this instance's Bot directory, which holds every Bot of the deployment in memory: Bots are in
 * Intelligence, and a network read per request is what the directory exists to avoid. The filter is
 * the one rule in team-bots/access.ts, applied before anything is built from a Bot, so a private
 * coworker the actor cannot see never becomes a registered agent, never has its key resolved, and
 * never reaches a response.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader },
  /** Secret for the deployment-managed Bot. Never sent to customer-owned endpoints. */
  managedAgent?: ManagedAgentConfig,
) {
  return async (actor: AgentActor): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, actor),
      selectTombstoneAgents(database, actor),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow(row);
      if (!agent) continue;
      const isRemoteAgent =
        agent.type === "remote_ag_ui" || agent.type === "remote_mastra";
      // The key is resolved per load, rather than being cached on the row: revoking a
      // credential then takes effect on the next run rather than on the next restart.
      if (isRemoteAgent && vault) {
        const headers = await agentAuthHeaders({
          reader: vault.reader,
          auth: authFromConfiguration(row.configuration),
          botId: agent.id,
          userId: actor.id,
        });
        if (headers) agent.headers = headers;
      }
      /*
       * Every endpoint this deployment runs gets the token, not just the first one.
       *
       * Matching a single endpoint left the harness picked during setup without it: registered,
       * addressable, routed to, and answering `401 unauthorised` to everything. Its container is
       * this deployment's own, started on a port this deployment chose with this token in its
       * environment, so it is the same relationship the Bot in the box has.
       */
      if (isRemoteAgent && managedAgent) {
        // Config parses URLs, while package rows retain their original spelling. Compare both
        // in canonical form so scheme/host case cannot silently drop the deployment token.
        const ours = isManagedEndpoint(agent.endpoint, [
          managedAgent.endpoint,
          managedAgent.alsoRun,
        ]);
        if (ours) {
          agent.headers = {
            ...agent.headers,
            "x-openbot-agent-token": managedAgent.token,
          };
        }
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

async function selectActiveAgents(database: Database, actor: AgentActor) {
  const access = await botAccessFor(database, actor);
  // The same Team Bot rule as the roster: see team-bots/access.ts.
  return bots()
    .live()
    .filter((bot) => access.canSee(bot));
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Registered so Intelligence can restore the thread the person is reading. Membership of a channel
 * the agent worked in is what authorizes this, not the profile's visibility, which is why deleting
 * a coworker leaves its conversations readable instead of erasing them.
 */
async function selectTombstoneAgents(database: Database, actor: AgentActor) {
  const deleted = bots()
    .cached()
    .filter((bot) => bot.deletedAt !== null);
  if (deleted.length === 0) return [];
  const rows = await database
    .selectDistinct({ id: channelAgents.agentId })
    .from(channelAgents)
    .innerJoin(
      channels,
      and(eq(channels.id, channelAgents.channelId), isNull(channels.deletedAt)),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(
      inArray(
        channelAgents.agentId,
        deleted.map((bot) => bot.id),
      ),
    );
  const withHistory = new Set(rows.map((row) => row.id));
  return deleted
    .filter((bot) => withHistory.has(bot.id))
    .map((bot) => ({ id: bot.id, name: bot.name }));
}
