import { checkAgentEndpoint } from "./endpoint";

/**
 * Ask an endpoint whether it is really an agent before it is stored.
 *
 * The registration form is the cheap point to distinguish a typo, a dead host, and a reachable
 * service that is not an AG-UI agent.
 *
 * AG-UI requires one POST to the endpoint returning an SSE stream of events (`@ag-ui/client`'s
 * `HttpAgent` is `{ url, headers?, fetch? }`). The test is a real run with a trivial message.
 */

/** How long an endpoint gets to answer. Short: this is a person waiting on a form. */
const TEST_TIMEOUT_MS = 15_000;

/** Enough of the stream to prove it is an agent. Reading it all could mean reading a whole reply. */
const MAX_BYTES = 8_000;

export type ConnectionTestResult =
  | {
      ok: true;
      /** The AG-UI event types that came back, in order, so a person sees it really answered. */
      events: string[];
      status: number;
    }
  | { ok: false; reason: string; status?: number };

/**
 * The smallest thing that is still a real run.
 *
 * Not a HEAD or a bare GET: plenty of things answer those. Only a POST that produces AG-UI events
 * distinguishes "an agent" from "a web server that happens to be reachable".
 */
function probeBody() {
  return {
    threadId: `openbot-connection-test-${crypto.randomUUID()}`,
    runId: `openbot-connection-test-${crypto.randomUUID()}`,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content:
          "This is an automated connection test from OpenBot. Reply with one short word.",
      },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

/** Pull `event:`/`data:` type names out of an SSE body, which is how AG-UI reports what it did. */
function eventTypesFrom(text: string): string[] {
  const types: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      types.push(trimmed.slice("event:".length).trim());
      continue;
    }
    // Most AG-UI servers put the type inside the JSON payload rather than on an `event:` line.
    if (trimmed.startsWith("data:")) {
      try {
        const parsed = JSON.parse(trimmed.slice("data:".length).trim()) as {
          type?: unknown;
        };
        if (typeof parsed.type === "string") types.push(parsed.type);
      } catch {
        // A fragment of a longer line. Not worth reporting: the summary is about whether events
        // arrived at all, and one unparsed chunk does not change that answer.
      }
    }
  }
  return [...new Set(types)];
}

/**
 * Try an endpoint and say what happened, in words a person can act on.
 *
 * Never throws. Every failure a person can cause, a typo, a dead host, an endpoint that answers HTML
 *, comes back as a reason, because this is rendered next to the field they just filled in.
 */
export async function testAgentConnection(
  rawEndpoint: unknown,
  options: {
    headers?: Record<string, string>;
    allowPrivateHosts?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ConnectionTestResult> {
  // Use the same target check that governs storing the endpoint, so this form cannot probe internal
  // addresses that registration would refuse.
  const verdict = checkAgentEndpoint(rawEndpoint, {
    allowPrivateHosts: options.allowPrivateHosts,
  });
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(verdict.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify(probeBody()),
      signal: AbortSignal.timeout(options.timeoutMs ?? TEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut
        ? "The agent did not answer in time. It may be starting up, or the address may be unreachable from this server."
        : "This server could not reach that address. If your agent runs on your own machine, it needs to be reachable from here, a tunnel, or somewhere this server can dial.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason:
        response.status === 401 || response.status === 403
          ? "The agent refused this request. If it needs a key, add it as a header."
          : `The agent answered ${response.status}. An AG-UI endpoint answers a POST with a stream of events.`,
    };
  }

  let body: string;
  try {
    body = (await response.text()).slice(0, MAX_BYTES);
  } catch {
    return {
      ok: false,
      status: response.status,
      reason: "The agent started answering and the connection broke.",
    };
  }

  const events = eventTypesFrom(body);
  if (events.length === 0) {
    // Reachable, and not an agent. The most useful thing to say is what it looked like instead.
    const contentType = response.headers.get("content-type") ?? "nothing";
    return {
      ok: false,
      status: response.status,
      reason: `That address answered, but not with AG-UI events (it sent ${contentType}). Check it is the agent's AG-UI path and not its home page.`,
    };
  }

  return { ok: true, events, status: response.status };
}
