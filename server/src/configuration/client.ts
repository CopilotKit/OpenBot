/**
 * Intelligence's agent access, end-user preferences, UI components, skills and agent packages, as
 * OpenBot calls them, under this deployment's project key. The contracts are Intelligence's
 * `docs/contracts/agent-configuration.md` and the five pages it links.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key, so a retry after a lost response is the same
 * write rather than a second one. Nothing here holds a database connection: a caller must never call
 * this with an OpenBot transaction open.
 *
 * This file is the one place OpenBot's words meet Intelligence's: a Bot is an agent, an `mcp` grant is
 * a `tool` grant, a `bot` grant an `agent` grant, a `team` publication is shared with `everyone`, a
 * server is an app, a transport is a channel and an update kind a category.
 */
import type {
  BotAccess,
  BotAccessChange,
  BotAccessChangeResult,
  ComponentEntry,
  ComponentSource,
  ComponentState,
  GrantKind,
  PackageRecord,
  PersonPreferences,
  PersonPreferencesChange,
  PersonPreferencesChangeResult,
  SkillEntry,
  SkillState,
} from "./types";

export type ConfigurationSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** The record changed since it was read (412), or a create met one that exists. Read it again. */
export class ConfigurationConflictError extends ConfigurationError {
  constructor(what: string, code: string | null) {
    super(`${what} changed since it was read.`, 412, code);
    this.name = "ConfigurationConflictError";
  }
}

/** No such record, or a write named a Bot Intelligence does not have. */
export class ConfigurationMissingError extends ConfigurationError {
  constructor(what: string, code: string | null) {
    super(`${what} is not in Intelligence.`, 404, code);
    this.name = "ConfigurationMissingError";
  }
}

export type Page<T> = { items: T[]; nextCursor: string | null };

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 500;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function configurationKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

export type ConfigurationClient = ReturnType<typeof createConfigurationClient>;

export function createConfigurationClient(settings: ConfigurationSettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
      ifNoneMatch?: boolean;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    if (options.ifNoneMatch) headers["if-none-match"] = "*";
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new ConfigurationError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof ConfigurationError) throw lastError;
    throw new ConfigurationError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(
    response: Response,
    what: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    if (response.status === 404)
      throw new ConfigurationMissingError(what, code);
    if (response.status === 412)
      throw new ConfigurationConflictError(what, code);
    throw new ConfigurationError(
      `Intelligence refused to ${action} ${what}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  async function json<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  /** Every page of a listing. There is no cap: the cursor decides the end. */
  async function walk<W, T>(
    path: string,
    from: (wire: W) => T,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: String(PAGE), ...query });
      if (cursor) params.set("cursor", cursor);
      const response = await request("GET", `${path}?${params}`);
      if (response.status !== 200) return refusal(response, path, "list");
      const page = await json<{ items: W[]; nextCursor: string | null }>(
        response,
      );
      items.push(...page.items.map(from));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  const enc = encodeURIComponent;

  return {
    access: {
      /** Every Bot's access record, deleted Bots' included. Bots with none are absent. */
      all: () => walk("/api/agent-access", accessFromWire),

      /** One Bot's access; revision 0 when it has none. Null when Intelligence has no such Bot. */
      async get(botId: string): Promise<BotAccess | null> {
        const response = await request(
          "GET",
          `/api/agents/${enc(botId)}/access`,
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refusal(response, `Bot ${botId}'s access`, "read");
        return accessFromWire(await json<WireAccess>(response));
      },

      /** Apply every change in one transaction: all of them or none. */
      async change(
        changes: BotAccessChange[],
        key: string,
        expectedRevisions?: Record<string, number>,
      ): Promise<{ results: BotAccessChangeResult[]; records: BotAccess[] }> {
        const response = await request("POST", "/api/agent-access/changes", {
          body: {
            changes: changes.map(accessChangeToWire),
            ...(expectedRevisions ? { expectedRevisions } : {}),
          },
          idempotencyKey: key,
        });
        if (response.status !== 200)
          return refusal(response, "Bot access", "change");
        const body = await json<{
          results: WireAccessResult[];
          records: WireAccess[];
        }>(response);
        return {
          results: body.results.map(accessResultFromWire),
          records: body.records.map(accessFromWire),
        };
      },
    },

    preferences: {
      all: () => walk("/api/end-user-preferences", preferencesFromWire),

      /** One person's preferences; revision 0 when they have set nothing. */
      async get(userId: string): Promise<PersonPreferences> {
        const response = await request(
          "GET",
          `/api/end-users/${enc(userId)}/preferences`,
        );
        if (response.status !== 200)
          return refusal(response, `${userId}'s preferences`, "read");
        return preferencesFromWire(await json<WirePreferences>(response));
      },

      async change(
        userId: string,
        changes: PersonPreferencesChange[],
        key: string,
        expectedRevision?: number,
      ): Promise<{
        results: PersonPreferencesChangeResult[];
        preferences: PersonPreferences;
      }> {
        const response = await request(
          "POST",
          `/api/end-users/${enc(userId)}/preferences/changes`,
          {
            body: { changes: changes.map(preferencesChangeToWire) },
            idempotencyKey: key,
            ...(expectedRevision === undefined
              ? {}
              : { ifMatch: expectedRevision }),
          },
        );
        if (response.status !== 200)
          return refusal(response, `${userId}'s preferences`, "change");
        const body = await json<{
          results: PersonPreferencesChangeResult[];
          preferences: WirePreferences;
        }>(response);
        return {
          results: body.results,
          preferences: preferencesFromWire(body.preferences),
        };
      },

      /**
       * Spend a one-time consent. True for exactly one caller, across every replica; a retry under the
       * same key answers what the first answered.
       */
      async consumeConsent(
        userId: string,
        botId: string,
        serverId: string,
        key: string,
      ): Promise<{ consumed: boolean; revision: number }> {
        const response = await request(
          "POST",
          `/api/end-users/${enc(userId)}/preferences/consume-consent`,
          { body: { agentId: botId, appId: serverId }, idempotencyKey: key },
        );
        if (response.status !== 200)
          return refusal(response, `${userId}'s consent`, "spend");
        return json<{ consumed: boolean; revision: number }>(response);
      },

      /** Remove everything a person set, for a person this deployment no longer has. */
      async purge(userId: string, key: string): Promise<void> {
        const response = await request(
          "DELETE",
          `/api/end-users/${enc(userId)}/preferences`,
          { idempotencyKey: key },
        );
        if (response.status !== 204)
          return refusal(response, `${userId}'s preferences`, "purge");
      },
    },

    components: {
      all: () => walk("/api/ui-components", componentFromWire),

      async get(name: string): Promise<ComponentEntry | null> {
        const response = await request(
          "GET",
          `/api/ui-components/${enc(name)}`,
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refusal(response, `Component ${name}`, "read");
        return componentFromWire(await json<WireComponent>(response));
      },

      /** Create one that does not exist yet. ConfigurationConflictError when it does. */
      async create(
        name: string,
        state: ComponentState,
        key: string,
      ): Promise<ComponentEntry> {
        const response = await request(
          "PUT",
          `/api/ui-components/${enc(name)}`,
          {
            body: componentStateToWire(state),
            ifNoneMatch: true,
            idempotencyKey: key,
          },
        );
        if (response.status !== 201 && response.status !== 200)
          return refusal(response, `Component ${name}`, "create");
        return componentFromWire(await json<WireComponent>(response));
      },

      /** Replace one at the version it was read at. ConfigurationConflictError when it moved on. */
      async replace(
        name: string,
        version: number,
        state: ComponentState,
        key: string,
      ): Promise<ComponentEntry> {
        const response = await request(
          "PUT",
          `/api/ui-components/${enc(name)}`,
          {
            body: componentStateToWire(state),
            ifMatch: version,
            idempotencyKey: key,
          },
        );
        if (response.status !== 200)
          return refusal(response, `Component ${name}`, "change");
        return componentFromWire(await json<WireComponent>(response));
      },

      /** True when this call removed it, false when it was already gone. */
      async remove(name: string, key: string, version?: number) {
        const response = await request(
          "DELETE",
          `/api/ui-components/${enc(name)}`,
          {
            idempotencyKey: key,
            ...(version === undefined ? {} : { ifMatch: version }),
          },
        );
        if (response.status === 404) return false;
        if (response.status !== 204)
          return refusal(response, `Component ${name}`, "remove");
        return true;
      },

      /** Announce what a build ships. Returns the names this call created; existing ones are untouched. */
      async register(
        updatedBy: string,
        entries: {
          name: string;
          title: string;
          kind: string;
          description: string;
        }[],
        key: string,
      ): Promise<string[]> {
        const response = await request("POST", "/api/ui-components/register", {
          body: {
            updatedBy,
            components: entries.map((entry) => ({
              name: entry.name,
              title: entry.title,
              category: entry.kind,
              description: entry.description,
            })),
          },
          idempotencyKey: key,
        });
        if (response.status !== 200)
          return refusal(response, "The component catalogue", "register");
        return (await json<{ added: string[] }>(response)).added;
      },
    },

    skills: {
      all: () => walk("/api/skills", skillFromWire),

      async get(slug: string): Promise<SkillEntry | null> {
        const response = await request("GET", `/api/skills/${enc(slug)}`);
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refusal(response, `Skill ${slug}`, "read");
        return skillFromWire(await json<WireSkill>(response));
      },

      async create(
        slug: string,
        state: SkillState,
        key: string,
      ): Promise<SkillEntry> {
        const response = await request("PUT", `/api/skills/${enc(slug)}`, {
          body: skillStateToWire(state),
          ifNoneMatch: true,
          idempotencyKey: key,
        });
        if (response.status !== 201 && response.status !== 200)
          return refusal(response, `Skill ${slug}`, "create");
        return skillFromWire(await json<WireSkill>(response));
      },

      async replace(
        slug: string,
        version: number,
        state: SkillState,
        key: string,
      ): Promise<SkillEntry> {
        const response = await request("PUT", `/api/skills/${enc(slug)}`, {
          body: skillStateToWire(state),
          ifMatch: version,
          idempotencyKey: key,
        });
        if (response.status !== 200)
          return refusal(response, `Skill ${slug}`, "change");
        return skillFromWire(await json<WireSkill>(response));
      },

      /** Removes the skill and every grant of it, together. False when it was already gone. */
      async remove(slug: string, key: string): Promise<boolean> {
        const response = await request("DELETE", `/api/skills/${enc(slug)}`, {
          idempotencyKey: key,
        });
        if (response.status === 404) return false;
        if (response.status !== 204)
          return refusal(response, `Skill ${slug}`, "remove");
        return true;
      },
    },

    packages: {
      async get(name: string): Promise<PackageRecord | null> {
        const response = await request(
          "GET",
          `/api/agent-packages/${enc(name)}`,
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refusal(response, `Package ${name}`, "read");
        return packageFromWire(await json<WirePackage>(response));
      },

      all: () => walk("/api/agent-packages", packageFromWire),

      /** Record that this package was applied. The first record of a name fixes its id for good. */
      async record(
        name: string,
        input: {
          id?: string;
          source: string;
          checksum: string;
          appliedAt?: Date;
        },
        key: string,
      ): Promise<PackageRecord> {
        const response = await request(
          "PUT",
          `/api/agent-packages/${enc(name)}`,
          {
            body: {
              source: input.source,
              checksum: input.checksum,
              ...(input.id ? { id: input.id } : {}),
              ...(input.appliedAt
                ? { appliedAt: input.appliedAt.toISOString() }
                : {}),
            },
            idempotencyKey: key,
          },
        );
        if (response.status !== 200 && response.status !== 201)
          return refusal(response, `Package ${name}`, "record");
        return packageFromWire(await json<WirePackage>(response));
      },
    },
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

const date = (value: string) => new Date(value);
const maybeDate = (value: string | null | undefined) =>
  value ? new Date(value) : null;
const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;

/* ------------------------------------------------------------------------------------------------
 * Agent access
 * ---------------------------------------------------------------------------------------------- */

type WireGrantKind = "tool" | "skill" | "agent";

const KIND_TO_WIRE: Record<GrantKind, WireGrantKind> = {
  mcp: "tool",
  skill: "skill",
  bot: "agent",
};
const KIND_FROM_WIRE: Record<WireGrantKind, GrantKind> = {
  tool: "mcp",
  skill: "skill",
  agent: "bot",
};

type WireAccess = {
  agentId: string;
  revision: number;
  updatedAt: string | null;
  grants: {
    kind: WireGrantKind;
    ref: string;
    grantedBy: string | null;
    grantedAs: "admin" | "owner";
    grantedAt: string;
    updatedAt: string;
  }[];
  sharing: {
    audience: "everyone" | "members";
    sharedBy: string;
    sharedAt: string;
    members: { kind: "user" | "group"; value: string; addedAt: string }[];
  } | null;
  assignments: { group: string; assignedBy: string; assignedAt: string }[];
};

type WireAccessResult = {
  outcome: BotAccessChangeResult["outcome"];
  revoked?: {
    agentId: string;
    kind: WireGrantKind;
    ref: string;
    grantedAs: "admin" | "owner";
  }[];
};

function accessFromWire(wire: WireAccess): BotAccess {
  return {
    botId: wire.agentId,
    revision: wire.revision,
    grants: wire.grants.map((grant) => ({
      kind: KIND_FROM_WIRE[grant.kind],
      ref: grant.ref,
      grantedBy: grant.grantedBy,
      grantedAs: grant.grantedAs,
      grantedAt: date(grant.grantedAt),
      updatedAt: date(grant.updatedAt),
    })),
    publication: wire.sharing
      ? {
          audience: wire.sharing.audience === "everyone" ? "team" : "people",
          publishedBy: wire.sharing.sharedBy,
          publishedAt: date(wire.sharing.sharedAt),
          members: wire.sharing.members.map((member) => ({
            kind: member.kind,
            value: member.value,
            addedAt: date(member.addedAt),
          })),
        }
      : null,
    assignments: wire.assignments.map((assignment) => ({
      group: assignment.group,
      assignedBy: assignment.assignedBy,
      assignedAt: date(assignment.assignedAt),
    })),
  };
}

function accessResultFromWire(wire: WireAccessResult): BotAccessChangeResult {
  return {
    outcome: wire.outcome,
    ...(wire.revoked
      ? {
          revoked: wire.revoked.map((grant) => ({
            botId: grant.agentId,
            kind: KIND_FROM_WIRE[grant.kind],
            ref: grant.ref,
            grantedAs: grant.grantedAs,
          })),
        }
      : {}),
  };
}

function accessChangeToWire(change: BotAccessChange): Record<string, unknown> {
  switch (change.op) {
    case "grant":
      return {
        op: "grant",
        agentId: change.botId,
        kind: KIND_TO_WIRE[change.kind],
        ref: change.ref,
        grantedBy: change.grantedBy,
        grantedAs: change.grantedAs,
        ifGranted: change.ifGranted,
        ...(change.grantedAt
          ? { grantedAt: change.grantedAt.toISOString() }
          : {}),
      };
    case "revoke":
      return {
        op: "revoke",
        agentId: change.botId,
        kind: KIND_TO_WIRE[change.kind],
        ref: change.ref,
      };
    case "revokeMatching":
      return {
        op: "revokeMatching",
        kind: KIND_TO_WIRE[change.kind],
        ...(change.botIds ? { agentIds: change.botIds } : {}),
        ...(change.ref !== undefined ? { ref: change.ref } : {}),
        ...(change.refPrefix !== undefined
          ? { refPrefix: change.refPrefix }
          : {}),
        ...(change.grantedBy !== undefined
          ? { grantedBy: change.grantedBy }
          : {}),
        ...(change.grantedAs !== undefined
          ? { grantedAs: change.grantedAs }
          : {}),
      };
    case "publish":
      return {
        op: "share",
        agentId: change.botId,
        audience: change.audience === "team" ? "everyone" : "members",
        members: change.audience === "team" ? [] : change.members,
        sharedBy: change.publishedBy,
        ...(change.publishedAt
          ? { sharedAt: change.publishedAt.toISOString() }
          : {}),
      };
    case "unpublish":
      return { op: "unshare", agentId: change.botId };
    case "assign":
      return {
        op: "assign",
        agentId: change.botId,
        group: change.group,
        assignedBy: change.assignedBy,
        ...(change.assignedAt
          ? { assignedAt: change.assignedAt.toISOString() }
          : {}),
      };
    case "unassign":
      return { op: "unassign", agentId: change.botId, group: change.group };
  }
}

/* ------------------------------------------------------------------------------------------------
 * End-user preferences
 * ---------------------------------------------------------------------------------------------- */

type WirePreferences = {
  userId: string;
  revision: number;
  instructions: string | null;
  instructionsUpdatedAt: string | null;
  agents: {
    agentId: string;
    hiddenAt: string | null;
    pinnedAt: string | null;
    pausedAt: string | null;
    notify: "all" | "needs_input" | "none";
    updatedAt: string;
  }[];
  notificationRoutes: {
    category: string;
    channels: string[];
    updatedAt: string;
  }[];
  declinedDefaults: {
    agentId: string;
    feature: string;
    scope: string;
    declinedAt: string;
  }[];
  agentConsents: {
    agentId: string;
    appId: string;
    decision: "always" | "once";
    updatedAt: string;
  }[];
  consentDefaults: { appId: string; updatedAt: string }[];
};

function preferencesFromWire(wire: WirePreferences): PersonPreferences {
  return {
    userId: wire.userId,
    revision: wire.revision,
    instructions: wire.instructions,
    instructionsUpdatedAt: maybeDate(wire.instructionsUpdatedAt),
    bots: wire.agents.map((agent) => ({
      botId: agent.agentId,
      hiddenAt: maybeDate(agent.hiddenAt),
      pinnedAt: maybeDate(agent.pinnedAt),
      pausedAt: maybeDate(agent.pausedAt),
      notify: agent.notify,
      updatedAt: date(agent.updatedAt),
    })),
    routes: wire.notificationRoutes.map((route) => ({
      kind: route.category,
      transports: route.channels,
      updatedAt: date(route.updatedAt),
    })),
    optOuts: wire.declinedDefaults.map((declined) => ({
      botId: declined.agentId,
      feature: declined.feature,
      scope: declined.scope,
      createdAt: date(declined.declinedAt),
    })),
    consents: wire.agentConsents.map((consent) => ({
      botId: consent.agentId,
      serverId: consent.appId,
      decision: consent.decision,
      updatedAt: date(consent.updatedAt),
    })),
    consentDefaults: wire.consentDefaults.map((consent) => ({
      serverId: consent.appId,
      updatedAt: date(consent.updatedAt),
    })),
  };
}

function preferencesChangeToWire(
  change: PersonPreferencesChange,
): Record<string, unknown> {
  switch (change.op) {
    case "setInstructions":
      return { op: "setInstructions", instructions: change.instructions };
    case "setBot": {
      const wire: Record<string, unknown> = {
        op: "setAgentPreference",
        agentId: change.botId,
      };
      if (change.hiddenAt !== undefined) wire.hiddenAt = iso(change.hiddenAt);
      if (change.pinnedAt !== undefined) wire.pinnedAt = iso(change.pinnedAt);
      if (change.pausedAt !== undefined) wire.pausedAt = iso(change.pausedAt);
      if (change.notify !== undefined) wire.notify = change.notify;
      return wire;
    }
    case "setRoute":
      return {
        op: "setNotificationRoute",
        category: change.kind,
        channels: change.transports,
      };
    case "optOut":
      return {
        op: "declineDefault",
        agentId: change.botId,
        feature: change.feature,
        scope: change.scope,
        ...(change.createdAt
          ? { declinedAt: change.createdAt.toISOString() }
          : {}),
      };
    case "setConsent":
      return {
        op: "setAgentConsent",
        agentId: change.botId,
        appId: change.serverId,
        decision: change.decision,
      };
    case "setConsentDefault":
      return {
        op: "setConsentDefault",
        appId: change.serverId,
        allowed: change.allowed,
      };
    case "clearConsents":
      return { op: "clearConsents" };
  }
}

/* ------------------------------------------------------------------------------------------------
 * UI components
 * ---------------------------------------------------------------------------------------------- */

type WireSourceVersion = {
  description: string;
  html: string;
  css: string;
  script: string;
  argumentSchema: Record<string, unknown>;
};

type WireSource = {
  draft: WireSourceVersion;
  published: WireSourceVersion | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  isPublished: boolean;
  publishedAt: string | null;
  authoredBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type WireComponent = {
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  category: string;
  draftDescription: string;
  publishedDescription: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedBy: string | null;
  functions: { name: string; grantedBy: string | null; grantedAt: string }[];
  withheldFrom: {
    agentId: string;
    withheldBy: string | null;
    withheldAt: string;
  }[];
  source: WireSource | null;
};

const versionFromWire = (wire: WireSourceVersion) => ({
  description: wire.description,
  html: wire.html,
  css: wire.css,
  jsFunctions: wire.script,
  argumentSchema: wire.argumentSchema,
});

const versionToWire = (version: ComponentSource["draft"]) => ({
  description: version.description,
  html: version.html,
  css: version.css,
  script: version.jsFunctions,
  argumentSchema: version.argumentSchema,
});

function componentFromWire(wire: WireComponent): ComponentEntry {
  return {
    name: wire.name,
    version: wire.version,
    title: wire.title,
    kind: wire.category,
    draftDescription: wire.draftDescription,
    publishedDescription: wire.publishedDescription,
    published: wire.published,
    publishedAt: maybeDate(wire.publishedAt),
    updatedBy: wire.updatedBy,
    createdAt: date(wire.createdAt),
    updatedAt: date(wire.updatedAt),
    functions: wire.functions.map((fn) => ({
      name: fn.name,
      grantedBy: fn.grantedBy,
      grantedAt: date(fn.grantedAt),
    })),
    withheldFrom: wire.withheldFrom.map((entry) => ({
      botId: entry.agentId,
      withheldBy: entry.withheldBy,
      withheldAt: date(entry.withheldAt),
    })),
    source: wire.source
      ? {
          draft: versionFromWire(wire.source.draft),
          published: wire.source.published
            ? versionFromWire(wire.source.published)
            : null,
          sampleArguments: wire.source.sampleArguments,
          revision: wire.source.revision,
          isPublished: wire.source.isPublished,
          publishedAt: maybeDate(wire.source.publishedAt),
          authoredBy: wire.source.authoredBy,
          createdAt: date(wire.source.createdAt),
          updatedAt: date(wire.source.updatedAt),
        }
      : null,
  };
}

function componentStateToWire(state: ComponentState): Record<string, unknown> {
  return {
    title: state.title,
    category: state.kind,
    draftDescription: state.draftDescription,
    publishedDescription: state.publishedDescription,
    published: state.published,
    publishedAt: iso(state.publishedAt),
    updatedBy: state.updatedBy,
    functions: state.functions.map((fn) => ({
      name: fn.name,
      grantedBy: fn.grantedBy,
      ...(fn.grantedAt ? { grantedAt: fn.grantedAt.toISOString() } : {}),
    })),
    withheldFrom: state.withheldFrom.map((entry) => ({
      agentId: entry.botId,
      withheldBy: entry.withheldBy,
      ...(entry.withheldAt
        ? { withheldAt: entry.withheldAt.toISOString() }
        : {}),
    })),
    source: state.source
      ? {
          draft: versionToWire(state.source.draft),
          published: state.source.published
            ? versionToWire(state.source.published)
            : null,
          sampleArguments: state.source.sampleArguments,
          revision: state.source.revision,
          isPublished: state.source.isPublished,
          publishedAt: iso(state.source.publishedAt),
          authoredBy: state.source.authoredBy,
        }
      : null,
    ...(state.createdAt ? { createdAt: state.createdAt.toISOString() } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Skills
 * ---------------------------------------------------------------------------------------------- */

type WireSkill = {
  slug: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  tools: { ref: string; declaredBy: string | null; declaredAt: string }[];
};

function skillFromWire(wire: WireSkill): SkillEntry {
  return {
    slug: wire.slug,
    version: wire.version,
    ownerUserId: wire.ownerUserId,
    title: wire.title,
    summary: wire.summary,
    instructions: wire.instructions,
    origin: wire.origin,
    installedBy: wire.installedBy,
    tools: wire.tools.map((tool) => ({
      ref: tool.ref,
      declaredBy: tool.declaredBy,
      declaredAt: date(tool.declaredAt),
    })),
    createdAt: date(wire.createdAt),
    updatedAt: date(wire.updatedAt),
  };
}

function skillStateToWire(state: SkillState): Record<string, unknown> {
  return {
    ownerUserId: state.ownerUserId,
    title: state.title,
    summary: state.summary,
    instructions: state.instructions,
    origin: state.origin,
    installedBy: state.installedBy,
    tools: state.tools.map((tool) => ({
      ref: tool.ref,
      declaredBy: tool.declaredBy,
    })),
    ...(state.createdAt ? { createdAt: state.createdAt.toISOString() } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Agent packages
 * ---------------------------------------------------------------------------------------------- */

type WirePackage = {
  id: string;
  name: string;
  version: number;
  source: string;
  checksum: string;
  appliedAt: string;
};

function packageFromWire(wire: WirePackage): PackageRecord {
  return {
    id: wire.id,
    name: wire.name,
    version: wire.version,
    source: wire.source,
    checksum: wire.checksum,
    appliedAt: date(wire.appliedAt),
  };
}
