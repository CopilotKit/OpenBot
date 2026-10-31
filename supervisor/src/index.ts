import { serve } from "bun";
import { Hono } from "hono";
import { authorised } from "./authorisation";
import { computerMemoryBytes } from "./computer-memory-bytes";
import {
  type CarryOverOutcome,
  ComputerNotAnsweringError,
  carryOverProfile,
  DockerUnavailableError,
  ensure,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  retireLegacyComputers,
  stop,
} from "./docker";
import { environmentFor } from "./environment";
import { registerEntry } from "./identity";
import { listenPort } from "./listen-port";
import { legacyNamesFor, namesFor } from "./names";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in whose computer it is rather than in Docker:
 * ensure a computer for this person (or this isolated Bot), stop it, reset it, list them. There is
 * no passthrough and no way to name a container directly; names are derived from the kind and the
 * id, which are validated first. A compromised API server can ask for a computer to be restarted. It
 * cannot ask for anything else, because nothing else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Neither is the network the boundary, but it is the layer in front of both. Compose publishes this
 * port on `127.0.0.1` rather than on every address the host has, for the same reason the computer's
 * own port is bound there: a secret in an environment variable is one leak away from being known,
 * and this process holds the Docker socket. This listener stays on every interface inside its own
 * container, which is what the published mapping forwards to and what a server running inside the
 * compose network connects to as `supervisor:4300`.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const resolvedPort = listenPort(process.env.PORT, 4300);
if (!resolvedPort.ok) {
  console.error(resolvedPort.reason);
  process.exit(1);
}
const port = resolvedPort.port;
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image =
  process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
const runtime = process.env.COMPUTER_RUNTIME?.trim() || undefined;
const resolvedMemory = computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES);
if (!resolvedMemory.ok) {
  console.error(resolvedMemory.reason);
  process.exit(1);
}
const memoryBytes = resolvedMemory.bytes;
const spireSocketVolume =
  process.env.SPIRE_AGENT_SOCKET_VOLUME?.trim() || undefined;

const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (!authorised(context.req.header("authorization"), token)) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/**
 * Whose computer the path names, validated before it becomes any kind of name.
 *
 * `/computers/person/<id>` is a person's computer, which carries every Bot they use;
 * `/computers/bot/<id>` is an isolated Bot's own.
 */
function resolve(kind: string, id: string) {
  return namesFor(kind, id);
}

/**
 * The private Bots whose old profile the server asks to give to this person, checked like any id.
 *
 * Optional, and only ever about a person's computer: an isolated Bot's computer inherits nothing.
 */
async function carryOverOf(
  request: Request,
): Promise<{ ok: true; bots: string[] } | { ok: false; reason: string }> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return { ok: true, bots: [] };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The body is not JSON." };
  }
  const carryOver = (body as { carryOver?: unknown } | null)?.carryOver;
  if (carryOver === undefined) return { ok: true, bots: [] };
  if (!Array.isArray(carryOver) || carryOver.length > 20) {
    return { ok: false, reason: "carryOver is a list of at most 20 bot ids." };
  }
  for (const bot of carryOver) {
    const checked = legacyNamesFor(bot);
    if (!checked.ok) return { ok: false, reason: checked.reason };
  }
  return { ok: true, bots: carryOver as string[] };
}

app.post("/computers/:kind/:id/ensure", async (context) => {
  const parsed = resolve(context.req.param("kind"), context.req.param("id"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  const asked = await carryOverOf(context.req.raw);
  if (!asked.ok) return context.json({ error: asked.reason }, 400);
  if (asked.bots.length > 0 && parsed.names.kind !== "person") {
    return context.json(
      { error: "Only a person's computer inherits a Bot's profile." },
      400,
    );
  }

  try {
    // Registered before the computer is handed out, so it can prove whose it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
    });
    /*
     * After the computer is up, before the server is answered: the server sends the Bot nothing until
     * this returns, so the Bot's folder in the profile volume does not exist yet and the copy can
     * land without racing a browser for it.
     */
    const carriedOver: Record<string, CarryOverOutcome> = {};
    for (const bot of asked.bots) {
      carriedOver[bot] = await carryOverProfile(parsed.names, bot, {
        image,
        ...(runtime ? { runtime } : {}),
      });
    }
    return context.json({
      ...state,
      ...(asked.bots.length > 0 ? { carriedOver } : {}),
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    // A held name is not an outage. 409 says the conflict is with something already there, so an
    // operator reads the message rather than going to look at a daemon that is working.
    if (error instanceof NameHeldError) {
      return context.json({ error: error.message }, 409);
    }
    // Not ready is a 503 like an outage is, because the caller's next move is the same: wait and
    // ask again. The message is what differs, and it is the part an operator acts on.
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    // Marked `starting`, because the container is up and still booting: the server tells the Bot
    // the call was not performed and is worth repeating, instead of reporting an outage.
    if (error instanceof ComputerNotAnsweringError) {
      return context.json({ error: error.message, starting: true }, 503);
    }
    throw error;
  }
});

app.post("/computers/:kind/:id/stop", async (context) => {
  const parsed = resolve(context.req.param("kind"), context.req.param("id"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:kind/:id/reset", async (context) => {
  const parsed = resolve(context.req.param("kind"), context.req.param("id"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

/*
 * The computers from before one per person, which nothing reaches any more, stopped once at start so
 * they stop holding a browser each. Their volumes stay. Not fatal: a supervisor that cannot do this
 * still serves today's computers, and says why in its log.
 */
void retireLegacyComputers()
  .then((stopped) => {
    if (stopped.length > 0) {
      console.info(
        JSON.stringify({
          type: "computer-legacy-stopped",
          stopped,
          note: "Computers from before one computer per person. Their volumes are kept.",
        }),
      );
    }
  })
  .catch((error: unknown) =>
    console.warn(
      JSON.stringify({
        type: "computer-legacy-stop-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
