/**
 * Bots as people see them: a Bot from Intelligence's agent registry, filtered by who may see it and
 * dressed with this person's own preferences (hidden, pinned).
 *
 * WHERE THINGS LIVE. The Bot (definition and profile) is in Intelligence and is read from this
 * instance's Bot directory (`bot-registry/directory.ts`), which holds them all in memory. Who may see a
 * Team Bot, and each person's hidden and pinned Bots, are this deployment's own tables. A write goes to
 * Intelligence first and the directory updates from its answer, so the next read here sees it.
 *
 * NO TRANSACTION SPANS INTELLIGENCE. A write to the registry is never made while an OpenBot transaction
 * is open. Where a Bot's key is involved, the vault write and the registry write are two steps in a
 * fixed order, and the second failing undoes or reports the first; see `create` and `update`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { capabilityRefusal } from "../admin/capabilities";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { agentPreferences } from "../db/schema";
import { teamBotPublications } from "../db/schema/team-bots";
import {
  type AccessExecutor,
  assignedCondition,
  botAccessFor,
} from "../team-bots/access";
import {
  type AgentAuth,
  authFromConfiguration,
  retireReplacedKey,
  storeAgentAuth,
} from "./auth-header";
import {
  BotDeletedError,
  BotMissingError,
  BotVersionConflictError,
} from "./bot-registry/client";
import { bots } from "./bot-registry/directory";
import type { Bot, BotChanges } from "./bot-registry/types";
import {
  hashCallbackToken,
  mintCallbackToken,
  sameToken,
} from "./callback-token";
import { mayIsolate } from "./isolation";
import { canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

/** Something that can read this deployment's own tables: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = AccessExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  /**
   * `get`, for a caller inside its own transaction.
   *
   * Reads this person's preferences and Team Bot reach on the caller's transaction, so it borrows no
   * second pooled connection (which deadlocks a caller holding the last one), and reads the Bot from
   * memory only: a transaction must not wait on Intelligence. A caller should look the Bot up with
   * `get` before it opens the transaction, which also brings a Bot made on another instance a moment
   * ago into this one's memory.
   */
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): Promise<AgentProfile | null>;
  create(
    actor: AgentActor,
    input: CreateAgentInput & {
      /**
       * The standing instruction for a coworker with nowhere else to run.
       *
       * Only consulted when there is neither an endpoint nor a Bot in the box, and it is what makes
       * that a `built_in` coworker rather than a refusal. `POST /api/agents` never sends it — the
       * form has no such field — so a hand-made Bot on a deployment without a managed agent is
       * refused exactly as it is today.
       *
       * Not on `CreateAgentInput`, so `update` cannot take it: changing an existing Bot's type is a
       * different act with different consequences, and this is the creation path.
       */
      systemPrompt?: string;
    },
  ): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
  ): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
  /**
   * Issue this agent a credential for calling tools back, and return it once.
   *
   * Returned rather than stored: only the hash is kept, so this is the one moment the token exists in
   * a readable form. Calling it again replaces the old one, which is how rotation works and how a
   * leaked token is retired.
   */
  issueCallbackToken(actor: AgentActor, id: string): Promise<string>;
  /** Take the credential away. The agent may talk, and may no longer call anything back. */
  revokeCallbackToken(actor: AgentActor, id: string): Promise<void>;
  /**
   * Which agent holds this token, if any.
   *
   * By hash, because that is all this side keeps. Not scoped to an actor: the caller is a machine
   * presenting a credential, and the credential is the whole of its claim.
   */
  agentForCallbackToken(hash: string): Promise<{ id: string } | null>;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

/**
 * A Bot was asked to have a computer of its own and may not.
 *
 * `capability`: the person asking does not hold "Isolated Bots". `unowned`: the Bot belongs to the
 * deployment rather than a person (a tenant package's Bot, or one whose owner was removed), and the
 * switch is a person's, so there is nobody it could be granted to. The route records both on the trail.
 */
export class IsolationRefusedError extends Error {
  /**
   * `forOwner`: the switch refused is the Bot's owner's, asked while somebody else (an administrator) edits it, so the
   * sentence names the owner rather than telling the editor their own switch is off.
   */
  constructor(
    readonly reason: "capability" | "unowned",
    options: { forOwner?: boolean } = {},
  ) {
    super(
      reason === "unowned"
        ? "This Bot doesn't belong to a person, so it can't have a computer of its own."
        : options.forOwner
          ? "An admin has turned off \"Isolated Bots\" for this Bot's owner, so it can't have a computer of its own."
          : capabilityRefusal("isolatedComputers"),
    );
    this.name = "IsolationRefusedError";
  }
}

/**
 * Refuse a Bot of its own to somebody without "Isolated Bots".
 *
 * Here rather than only at the route, so every caller of the store meets it, as publishing a Team Bot
 * does. Asked only of a request that turns isolation ON: turning it off is always allowed, and an
 * absent field changes nothing.
 *
 * Asked before anything is written, so a refusal leaves nothing behind.
 */
async function requireMayIsolate(actor: AgentActor) {
  if (!(await mayIsolate(actor.id))) {
    throw new IsolationRefusedError("capability");
  }
}

/**
 * Refuse a computer of its own to a Bot whose OWNER lacks "Isolated Bots", whoever is editing it.
 *
 * The owner's switch is the one that decides at run time (`runsIsolated` in isolation.ts), so it is the one asked here:
 * asking the editor let an administrator tick Isolated on somebody's Bot whose owner lacks the switch, the save
 * succeeded, and the Bot never ran isolated. Asked before anything is written. An unknown Bot, and one that belongs to
 * nobody, are refused by the update itself, each for its own reason.
 */
async function requireOwnerMayIsolate(actor: AgentActor, agentId: string) {
  const owner = (await bots().find(agentId))?.ownerUserId;
  if (!owner || (await mayIsolate(owner))) return;
  throw new IsolationRefusedError("capability", {
    forOwner: owner !== actor.id,
  });
}

export class ManagedAgentUnavailableError extends Error {
  constructor() {
    super("OpenBot has no managed Bot. Give this Bot its own AG-UI endpoint.");
    this.name = "ManagedAgentUnavailableError";
  }
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/** Which agent on a Mastra server this Bot means, when the row names one. */
function remoteAgentIdOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const named = (configuration as { remoteAgentId?: unknown }).remoteAgentId;
  return typeof named === "string" && named.length > 0 ? named : null;
}

/**
 * The instruction a Bot in the box runs on, read back out of its stored configuration.
 *
 * The mirror of {@link endpointOf}, and needed for the same reason: a copy has to be made of what
 * the original actually was, and for a `built_in` coworker the prompt IS the coworker. Trimmed and
 * required to be non-empty, matching `registeredAgentFromRow`, which will not build a Bot from a
 * blank one either.
 */
function systemPromptOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const prompt = (configuration as { systemPrompt?: unknown }).systemPrompt;
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What a coworker is, and what it runs on: the two `agents` columns a copy has to reproduce. */
export type AgentRun = {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: Record<string, unknown>;
};

/**
 * What a duplicate runs on, decided from what the original ran on.
 *
 * WHY THIS IS NOT JUST THE ENDPOINT. Duplicate used to rebuild the copy from `source.endpoint` alone
 * and write `type: "remote_ag_ui"` flat. #328 fixed the half of that a coworker with its own endpoint
 * saw. The other half is a coworker that has no endpoint because it is not supposed to have one: a
 * `built_in` Bot's configuration is `{ systemPrompt }`, so the endpoint read came back null, the copy
 * fell through to the managed Bot, and the prompt was dropped on the floor.
 *
 * That copy is the failure this repository already has a paragraph about. It looks identical on every
 * screen and its whole instruction becomes `standingRoleMessage` — see the note above that function
 * in `copilot.ts`, which names the compliance Bot that answered a filing question with invented
 * thresholds because one sentence of role description was all that reached it. The default tenant
 * package ships two `built_in` coworkers, and one of them, `Knowledge`, is a careful
 * do-not-fabricate instruction. Copy it and you get a coworker with the name, the title, the avatar,
 * and none of that.
 *
 * The type is carried too, not only the configuration, so a copy runs the same way its original
 * does.
 *
 * `null` means there is nothing to run this copy on, which the caller turns into
 * {@link ManagedAgentUnavailableError}. That can now only happen for a source that had neither an
 * endpoint nor a prompt on a deployment with no managed Bot — never for a `built_in` source, which
 * brings its own instruction and needs no managed Bot to fall back to.
 *
 * `auth` is deliberately not carried: it is a reference into the vault, and two coworkers sharing one
 * credential would mean rotating either one's key silently changed the other's.
 */
export function runForDuplicate(
  source: {
    type: "built_in" | "remote_ag_ui" | "remote_mastra";
    configuration: unknown;
  },
  managed: Record<string, unknown> | undefined,
): AgentRun | null {
  const systemPrompt = systemPromptOf(source.configuration);
  if (source.type === "built_in" && systemPrompt) {
    return { type: "built_in", configuration: { systemPrompt } };
  }

  const endpoint = endpointOf(source.configuration);
  if (endpoint) {
    /*
     * The copy is dialled the way the original was, and that is not cosmetic. A Mastra endpoint
     * speaks Mastra's client protocol and has no AG-UI route, so a duplicate written as
     * `remote_ag_ui` would carry the right address and be unable to say anything to it. The Bot
     * would appear, accept a grant, and answer nothing.
     *
     * Which agent on that server comes with it for the same reason: a Mastra endpoint is a roster,
     * and a copy that forgets the name falls back to a different agent, or refuses. See
     * `pickFromRoster`.
     */
    if (source.type === "remote_mastra") {
      const remoteAgentId = remoteAgentIdOf(source.configuration);
      return {
        type: "remote_mastra",
        configuration: remoteAgentId
          ? { endpoint, remoteAgentId }
          : { endpoint },
      };
    }
    return { type: "remote_ag_ui", configuration: { endpoint } };
  }

  return managed ? { type: "remote_ag_ui", configuration: managed } : null;
}

type Preferences = { hiddenAt: Date | null; pinnedAt: Date | null };

/** This person's hidden and pinned marks, for the Bots asked about or for all of them. */
async function preferencesOf(
  executor: AccessExecutor,
  actorId: string,
  botIds?: readonly string[],
): Promise<Map<string, Preferences>> {
  if (botIds && botIds.length === 0) return new Map();
  const rows = await executor
    .select({
      agentId: agentPreferences.agentId,
      hiddenAt: agentPreferences.hiddenAt,
      pinnedAt: agentPreferences.pinnedAt,
    })
    .from(agentPreferences)
    .where(
      and(
        eq(agentPreferences.userId, actorId),
        botIds ? inArray(agentPreferences.agentId, [...botIds]) : undefined,
      ),
    );
  return new Map(
    rows.map((row) => [
      row.agentId,
      { hiddenAt: row.hiddenAt, pinnedAt: row.pinnedAt },
    ]),
  );
}

/** A Bot as a profile for this person. */
export function profileOf(
  bot: Bot,
  preferences: Preferences | undefined,
  assignedToMe: boolean,
): AgentProfile {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    roleDescription: bot.roleDescription,
    avatarSeed: bot.avatarSeed,
    visibility: bot.visibility,
    ownerUserId: bot.ownerUserId,
    systemOwned: bot.packageId !== null,
    hasCallbackToken: bot.callbackTokenHash !== null,
    hidden: (preferences?.hiddenAt ?? null) !== null,
    pinned: (preferences?.pinnedAt ?? null) !== null,
    assignedToMe,
    deletedAt: bot.deletedAt,
    isolated: bot.isolated,
    endpoint: endpointOf(bot.configuration),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(bot.configuration) !== null,
  };
}

/** The profile of a live Bot this person may see, or null. */
async function accessibleProfile(
  executor: AccessExecutor,
  actor: AgentActor,
  bot: Bot | null | undefined,
): Promise<AgentProfile | null> {
  if (!bot || bot.deletedAt !== null) return null;
  const access = await botAccessFor(executor, actor);
  if (!access.canSee(bot)) return null;
  const preferences = await preferencesOf(executor, actor.id, [bot.id]);
  return profileOf(bot, preferences.get(bot.id), access.assignedToMe(bot));
}

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

/** Hiding a Team Bot an administrator assigned to this person, which they cannot do. */
export class AgentAssignedError extends Error {
  constructor(_id: string) {
    super("This Bot was assigned to you by an admin and can't be hidden.");
    this.name = "AgentAssignedError";
  }
}

/** How many times an edit is redone on top of somebody else's that saved first. */
const EDIT_ATTEMPTS = 3;

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL | undefined,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore },
): AgentProfileStore {
  const managedConfiguration = managedAgentAgUiUrl
    ? { endpoint: managedAgentAgUiUrl.toString() }
    : undefined;

  /**
   * Change a Bot this person may manage, redoing the change on the latest copy when somebody else
   * saved first. `change` sees the Bot as it is now and returns what to write; it may throw to refuse.
   */
  async function edit(
    actor: AgentActor,
    id: string,
    change: (
      bot: Bot,
      profile: AgentProfile,
    ) => Promise<BotChanges> | BotChanges,
    options: { manage: boolean } = { manage: true },
  ): Promise<Bot> {
    let bot = await bots().find(id);
    for (let attempt = 1; ; attempt++) {
      const profile = await accessibleProfile(database, actor, bot);
      if (!bot || !profile) throw new AgentNotFoundError(id);
      if (options.manage) requireManageable(actor, profile);
      const changes = await change(bot, profile);
      try {
        return await bots().update(id, bot.version, changes);
      } catch (error) {
        if (
          error instanceof BotMissingError ||
          error instanceof BotDeletedError
        )
          throw new AgentNotFoundError(id);
        if (
          !(error instanceof BotVersionConflictError) ||
          attempt >= EDIT_ATTEMPTS
        )
          throw error;
        bot = await bots().refresh(id);
      }
    }
  }

  async function profileAfterWrite(actor: AgentActor, bot: Bot) {
    const profile = await accessibleProfile(database, actor, bot);
    if (!profile) throw new AgentNotFoundError(bot.id);
    return profile;
  }

  return {
    async list(actor, hidden = false) {
      const access = await botAccessFor(database, actor);
      const preferences = await preferencesOf(database, actor.id);
      return bots()
        .live()
        .filter((bot) => access.canSee(bot))
        .filter((bot) => {
          const hiddenAt = preferences.get(bot.id)?.hiddenAt ?? null;
          return hidden ? hiddenAt !== null : hiddenAt === null;
        })
        .map((bot) =>
          profileOf(bot, preferences.get(bot.id), access.assignedToMe(bot)),
        );
    },

    async get(actor, id) {
      return accessibleProfile(database, actor, await bots().find(id));
    },

    async getWithin(executor, actor, id) {
      return accessibleProfile(executor, actor, bots().peek(id));
    },

    async create(actor, input) {
      if (input.isolated === true) await requireMayIsolate(actor);
      const id = newAgentId();
      const endpoint = input.endpoint
        ? { endpoint: input.endpoint }
        : managedConfiguration;
      const systemPrompt = input.systemPrompt?.trim();
      /*
       * No address, no Bot in the box, and no instruction to run on. There is nothing to create: a
       * `built_in` Bot with an empty prompt is a coworker `registeredAgentFromRow` drops on the floor,
       * and the Bot would exist on every screen while answering nobody.
       */
      if (!endpoint && !systemPrompt) throw new ManagedAgentUnavailableError();

      /*
       * The key, if there is one, goes to the vault and only its reference to Intelligence. See
       * auth-header.ts for why a bearer token must not sit next to the endpoint. Stored first, so the
       * Bot never exists in Intelligence naming a key that is not there; retired again if Intelligence
       * then refuses the Bot.
       *
       * Not on the `built_in` branch: a key authenticates to an address and that coworker has none, so
       * storing one would leave a live credential in the vault that nothing can ever present.
       */
      let auth: AgentAuth | undefined;
      if (endpoint && input.auth && vault) {
        auth = await storeAgentAuth({
          store: vault.store,
          agentId: id,
          header: input.auth.header,
          value: input.auth.value,
        });
      }
      let bot: Bot;
      try {
        bot = await bots().create({
          id,
          name: input.name,
          title: input.title,
          roleDescription: input.roleDescription,
          avatarSeed: id,
          visibility: input.visibility,
          ownerUserId: actor.id,
          packageId: null,
          isolated: input.isolated === true,
          // Their endpoint if they gave one, ours if they did not. Validated before it reaches here;
          // see endpoint.ts for why a stored URL is a security decision and not a text field.
          ...(endpoint
            ? {
                type: "remote_ag_ui" as const,
                configuration: { ...endpoint, ...(auth ? { auth } : {}) },
              }
            : {
                /*
                 * Nowhere to send it, so it runs here: the shape General Assistant and Knowledge
                 * already have, and the shape `registeredAgentFromRow` reads.
                 */
                type: "built_in" as const,
                configuration: { systemPrompt },
              }),
        });
      } catch (error) {
        if (auth && vault) await retireReplacedKey(vault.store, { auth }, {});
        throw error;
      }
      return profileAfterWrite(actor, bot);
    },

    async update(actor, id, input) {
      if (input.isolated === true) await requireOwnerMayIsolate(actor, id);
      /*
       * The key is stored once, before the first attempt, and named by every attempt after it. A key
       * that is stored and then never named because every attempt failed is said loudly below; the
       * next save of a key rotates it (see `storeAgentAuth`).
       */
      let auth: AgentAuth | undefined;
      try {
        // `manage: false` because this change makes the manage check itself, after the refusal below.
        const updated = await edit(
          actor,
          id,
          async (bot, profile) => {
            /*
             * Before the manage check, so a tenant package's Bot is refused for what was asked of it
             * rather than with the general "built in and can't be changed", and the trail can say so.
             */
            if (
              input.isolated === true &&
              (profile.systemOwned || profile.ownerUserId === null)
            ) {
              throw new IsolationRefusedError("unowned");
            }
            requireManageable(actor, profile);
            if (input.auth && vault && !auth) {
              // An agent that already has a live key is being edited, not first-created, so the vault
              // rotates rather than inserting a second live row for the same agent id.
              auth = await storeAgentAuth({
                store: vault.store,
                agentId: id,
                header: input.auth.header,
                value: input.auth.value,
                previousCredentialId: authFromConfiguration(bot.configuration)
                  ?.credentialId,
              });
            }
            /**
             * The endpoint and the key change here too, not only at creation.
             *
             * The form sends both and the route validates both, so an edit that dropped them looked
             * like it had worked: the screen reported success and the Bot kept answering at the old
             * address, which is the worst way to move an endpoint. A key is replaced only when one is
             * supplied, because the form cannot show what is stored and sending nothing means "leave
             * it alone" rather than "remove it".
             *
             * A coworker that runs here runs on its role description, so editing one has to move both:
             * `create` writes it into `configuration.systemPrompt` for a coworker with no address, and
             * that prompt is the ONLY instruction such a coworker ever gets. Only for `built_in`: a
             * remote Bot's instruction travels as the standing role message instead, and the tenant
             * package's Bots, whose `system_prompt` is deliberately not their `role_description`,
             * cannot reach this code at all: `requireManageable` refuses anything the package owns.
             */
            const configuration = {
              ...bot.configuration,
              ...(bot.type === "built_in"
                ? { systemPrompt: input.roleDescription }
                : {}),
              ...(input.endpoint ? { endpoint: input.endpoint } : {}),
              ...(auth ? { auth } : {}),
            };
            return {
              name: input.name,
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              configuration,
              // Absent leaves it alone; see `CreateAgentInput.isolated`.
              ...(input.isolated === undefined
                ? {}
                : { isolated: input.isolated }),
            };
          },
          { manage: false },
        );
        return profileAfterWrite(actor, updated);
      } catch (error) {
        if (auth) {
          console.error(
            JSON.stringify({
              type: "agent-key-stored-not-named",
              botId: id,
              credentialId: auth.credentialId,
              note: "A Bot's new key is in the vault but Intelligence did not record it, so the Bot still names the key it had. Saving the key again replaces both.",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        throw error;
      }
    },

    async duplicate(actor, id) {
      /*
       * A copy is the duplicator's Bot, so it keeps a computer of its own only if they may give it
       * one. Asked up front, and answered for every duplicate rather than only an isolated source's.
       */
      const mayKeepIsolated = await mayIsolate(actor.id);
      const stored = await bots().find(id);
      const source = await accessibleProfile(database, actor, stored);
      if (!stored || !source) throw new AgentNotFoundError(id);

      /*
       * The stored Bot, because a profile does not carry what a copy has to reproduce: `AgentProfile`
       * projects `endpoint` out of the configuration and nothing else, and a `built_in` coworker has
       * no endpoint and a prompt instead. `auth` is a vault reference and is deliberately not carried:
       * see `runForDuplicate`.
       */
      const run = runForDuplicate(stored, managedConfiguration);
      // After the source read, so a source that brings its own endpoint or its own prompt needs no
      // managed Bot to fall back to.
      if (!run) {
        throw new ManagedAgentUnavailableError();
      }
      const duplicate = await bots().create({
        id: newAgentId(),
        name: source.name,
        type: run.type,
        configuration: run.configuration,
        title: source.title,
        roleDescription: source.roleDescription,
        avatarSeed: source.avatarSeed,
        visibility: "private",
        ownerUserId: actor.id,
        packageId: null,
        isolated: source.isolated && mayKeepIsolated,
      });
      return profileAfterWrite(actor, duplicate);
    },

    async setHidden(actor, id, hidden) {
      const bot = await bots().find(id);
      await database.transaction(async (transaction) => {
        const profile = await accessibleProfile(transaction, actor, bot);
        if (!profile) throw new AgentNotFoundError(id);
        // An administrator put this Team Bot in this person's sidebar; it stays there.
        if (hidden) {
          const [assigned] = await transaction
            .select({ agentId: teamBotPublications.agentId })
            .from(teamBotPublications)
            .where(
              and(
                eq(teamBotPublications.agentId, id),
                assignedCondition(actor.id),
              ),
            )
            .limit(1);
          if (assigned) throw new AgentAssignedError(id);
        }

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    /*
     * The same row as hiding, one column over, and the upsert sets only its own column: pinning a
     * hidden coworker keeps it hidden, and it comes back pinned when it is unhidden. Two people, or
     * two tabs, pinning at once meet on the (user, agent) primary key, so the second write updates
     * the row the first one made instead of failing.
     */
    async setPinned(actor, id, pinned) {
      const bot = await bots().find(id);
      await database.transaction(async (transaction) => {
        const profile = await accessibleProfile(transaction, actor, bot);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            pinnedAt: pinned ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { pinnedAt: pinned ? new Date() : null },
          });
      });
    },

    async softDelete(actor, id) {
      let bot = await bots().find(id);
      for (let attempt = 1; ; attempt++) {
        const profile = await accessibleProfile(database, actor, bot);
        if (!bot || !profile) throw new AgentNotFoundError(id);
        requireManageable(actor, profile);
        try {
          // At the version just checked, so a Bot that became protected meanwhile (a package took
          // it over) is read again and refused rather than deleted.
          await bots().remove(id, undefined, bot.version);
          break;
        } catch (error) {
          if (error instanceof BotMissingError)
            throw new AgentNotFoundError(id);
          if (
            !(error instanceof BotVersionConflictError) ||
            attempt >= EDIT_ATTEMPTS
          )
            throw error;
          bot = await bots().refresh(id);
        }
      }

      /*
       * And its key stops working.
       *
       * A deleted Bot left its credential in the vault, decryptable and still valid, with nothing
       * listing it and no screen able to reach it: deleting the Bot was the last chance anybody had
       * to retire it. The Bot is a soft delete, deliberately, but the key is not something to keep
       * pending an undelete that would ask for a new one anyway. After Intelligence has deleted the
       * Bot, so a refused delete leaves a Bot that still reaches its endpoint; `retireReplacedKey`
       * never throws, and says so loudly if the vault refuses.
       */
      if (vault) {
        await retireReplacedKey(vault.store, bot.configuration, {});
      }
    },

    async issueCallbackToken(actor, id) {
      /*
       * Whoever may change the agent may credential it.
       *
       * The same gate as renaming it or repointing its endpoint, and repointing the endpoint is
       * the more dangerous of the two: it decides which process the token is for.
       */
      const token = mintCallbackToken();
      const issuedAt = new Date();
      await edit(actor, id, () => ({
        callbackTokenHash: hashCallbackToken(token),
        callbackTokenIssuedAt: issuedAt,
      }));
      // The only time it is readable. Nothing here writes it to a log.
      return token;
    },

    async revokeCallbackToken(actor, id) {
      await edit(actor, id, () => ({
        callbackTokenHash: null,
        callbackTokenIssuedAt: null,
      }));
    },

    /**
     * Which agent a token belongs to.
     *
     * Found by hash and then compared in constant time. The lookup alone would be enough to identify
     * the Bot, and the comparison is what keeps a timing difference from confirming a partial guess.
     */
    async agentForCallbackToken(hash) {
      const bot = await bots().byCallbackTokenHash(hash);
      if (!bot?.callbackTokenHash) return null;
      return sameToken(bot.callbackTokenHash, hash) ? { id: bot.id } : null;
    },
  };
}
