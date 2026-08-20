import { serve } from "bun";
import { createAgentProfileStore } from "./agents/profile-store";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { createApp } from "./app";
import { createAuditReader, createAuditStore, recordAuditEvent } from "./audit";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import { createRoleRepository } from "./auth/guards";
import type { OpenBotRole } from "./auth/roles";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { createStallGuard } from "./channels/stall-guard";
import { createThreadIdentity } from "./channels/thread-identity";
import { websocket as channelSocket } from "./channels/socket";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerClient } from "./computer/client";
import { createComputerGateway } from "./computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import { createDaytonaSupervisorClient } from "./computer/daytona";
import { createSupervisorClient } from "./computer/supervisor";
import { loadConfig } from "./config";
import { createConnectorAdminService } from "./connectors";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import { createPluginStore } from "./plugins/store";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.devNoAuth) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const database = createDatabase(config.databaseUrl);
await initializeDevActorUser(database, config.devNoAuth);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgentAgUiUrl,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
const loadAgentsForActor = createRuntimeAgentLoader(database, agentVault);
await synchronizeTenantPackage(database, tenantPackage);
const auth = config.auth ? createAuth(config, database) : undefined;
const daytonaSupervisor =
  config.computer?.daytona && config.computer.token
    ? createDaytonaSupervisorClient({
        ...config.computer.daytona,
        computerToken: config.computer.token,
        environment: process.env,
      })
    : undefined;
// Kick the snapshot build off at boot so the first person to open a computer
// is not the one who waits minutes for an image build.
if (daytonaSupervisor) void daytonaSupervisor.warm();
const supervisor =
  daytonaSupervisor ??
  (config.computer?.supervisor
    ? createSupervisorClient(config.computer.supervisor)
    : undefined);
const computerClient = config.computer
  ? createComputerClient({
      ...(config.computer.baseUrl ? { baseUrl: config.computer.baseUrl } : {}),
      allowPrivateHosts: config.computer.allowPrivateHosts,
      ...(config.computer.token ? { token: config.computer.token } : {}),
      ...(supervisor
        ? { resolveBaseUrl: (botId: string) => supervisor.locate(botId) }
        : {}),
    })
  : undefined;
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * Without a supervisor every Bot shares the browser at `AGENT_COMPUTER_URL`. That is a fine way to
 * run on a laptop, but the shared isolation state must be visible rather than inferred.
 */
void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  payload: daytonaSupervisor
    ? {
        isolation: "one computer per Bot",
        note: "Each Bot gets a remote Daytona sandbox with its own /workspace and its own browser profile.",
      }
    : supervisor
      ? {
          isolation: "one computer per Bot",
          note: "Each Bot gets its own container, its own /workspace and its own browser profile.",
        }
      : {
          isolation: "one shared computer",
          note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY to give each Bot its own.",
        },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: daytonaSupervisor
      ? "Daytona"
      : supervisor
        ? "Docker supervisor"
        : "shared",
    isolation: supervisor ? "one computer per Bot" : "one shared computer",
    ...(supervisor
      ? {}
      : {
          warning:
            "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL or DAYTONA_API_KEY for a computer each.",
        }),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  createConnectorAdminService(
    tenantPackage.knowledgeSources,
    database,
    createCredentialAdminService(
      config.keyEncryptionKey,
      credentialStore,
      createAuditStore(database),
    ),
  ),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  mountCopilotRuntime(
    config,
    tenantPackage.model,
    loadAgentsForActor,
    () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: tenantPackage.model.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
    identifyUser,
    identifyActor,
    stallGuard,
  ),
  computerClient,
  // The only path to an acting call.
  computerClient
    ? createComputerGateway({
        client: computerClient,
        auditStore: bootAuditStore,
        // Read on every decision rather than captured once, so a rule an administrator adds while the
        // server is running applies to the very next action instead of after a restart.
        policy: () => policyStore.get(),
        // Stop, reset and the listing act on containers when there are containers to act on.
        ...(supervisor ? { supervisor } : {}),
      })
    : undefined,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = { upstream: string; inward?: WebSocket };

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await identifyUser(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // Located per Bot when there is a supervisor, and the one shared computer when there is not.
      let upstream: string;
      try {
        const streamBase = supervisor
          ? await supervisor.locate(streamBotId)
          : config.computer.baseUrl;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = toStreamUrl(streamBase, streamBotId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.devNoAuth) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "OPENBOT_DEV_NO_AUTH is on: every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Local development only.`,
  );
}

// The activity listener holds a connection of its own for the life of the process. Released on the
// way out, so a watch-mode restart does not leave one behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void channelActivityListener.stop().finally(() => process.exit(0));
  });
}

console.info(`OpenBot server listening on http://localhost:${port}`);
