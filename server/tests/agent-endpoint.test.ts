import { describe, expect, test } from "bun:test";
import { dynamicToolsOf } from "../../agent-codex/src/tools";
import { mintRunAssertion } from "../src/agents/callback-token";
import { agentAuthHeaders, storeAgentAuth } from "../src/agents/auth-header";
import { testAgentConnection } from "../src/agents/connection-test";
import {
  checkAgentEndpoint,
  createAgentFetch,
  EndpointNotAllowedError,
} from "../src/agents/endpoint";
import { parseAgentInput } from "../src/agents/routes";
import { createApp } from "../src/app";
import type { ComputerGateway } from "../src/computer/gateway";
import { loadConfig } from "../src/config";
import { remoteComputerToolAliases } from "../src/copilot";
import { testEnvironment } from "./support/environment";

/** A 32-byte key, as the vault expects. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Registering an external agent, tested as the security surface it is.
 *
 * The endpoint is a URL a user chooses and this server then POSTs to on every run. The failure mode
 * is an ordering one: if the private-host escape hatch is consulted before the deny-list, the cloud
 * metadata address becomes reachable under the configuration developers actually run. So these tests
 * run with the escape hatch both ways. A deny-list only ever tested with the hatch off proves nothing
 * about the configuration that matters.
 */

describe("what may be registered as an agent", () => {
  test("an ordinary https endpoint is allowed", () => {
    const verdict = checkAgentEndpoint("https://agents.example.com/ag-ui");
    expect(verdict).toEqual({
      allowed: true,
      url: "https://agents.example.com/ag-ui",
    });
  });

  test("cloud metadata is refused even with private hosts allowed", () => {
    // On a laptop `allowPrivateHosts` is on, which is exactly the configuration where an ordering
    // mistake survives.
    for (const allowPrivateHosts of [false, true]) {
      const verdict = checkAgentEndpoint(
        "http://169.254.169.254/latest/meta-data/",
        {
          allowPrivateHosts,
        },
      );
      expect(verdict.allowed).toBe(false);
    }
  });

  test("a private address is refused when private hosts are not allowed", () => {
    const verdict = checkAgentEndpoint("http://10.0.0.5:4200/ag-ui");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("network");
  });

  test("localhost is allowed only where the deployment opted in", () => {
    // A developer's own agent lives here, and a hosted deployment must refuse it.
    expect(
      checkAgentEndpoint("http://localhost:4200/ag-ui", {
        allowPrivateHosts: true,
      }).allowed,
    ).toBe(true);
    expect(checkAgentEndpoint("http://localhost:4200/ag-ui").allowed).toBe(
      false,
    );
  });

  test("non-web schemes are refused", () => {
    // `file:` would read the server's disk; `javascript:` is nonsense that should not reach storage.
    for (const raw of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://x/y",
    ]) {
      expect(checkAgentEndpoint(raw).allowed).toBe(false);
    }
  });

  test("junk is refused rather than stored", () => {
    for (const raw of ["", "   ", "not a url", null, undefined, 42, {}]) {
      expect(checkAgentEndpoint(raw).allowed).toBe(false);
    }
  });
});

describe("the agent form", () => {
  const base = {
    name: "Sales Bot",
    title: "Sales",
    roleDescription: "Answers questions about pricing.",
    visibility: "private",
  };

  test("an agent with no endpoint is valid, and runs on the Bot in the box", () => {
    const parsed = parseAgentInput(base);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.endpoint).toBeUndefined();
  });

  test("an endpoint is carried through when it is allowed", () => {
    const parsed = parseAgentInput(
      { ...base, endpoint: "https://agents.example.com/ag-ui" },
      false,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.endpoint).toBe("https://agents.example.com/ag-ui");
  });

  test("a refused endpoint fails the whole form rather than being dropped", () => {
    // Ignoring it would create a Bot that appears external but uses the built-in agent.
    const parsed = parseAgentInput(
      { ...base, endpoint: "http://169.254.169.254/" },
      true,
    );
    expect(parsed.ok).toBe(false);
  });

  test("an empty endpoint means the default, not an error", () => {
    // What a form sends when somebody clears the field.
    const parsed = parseAgentInput({ ...base, endpoint: "" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.endpoint).toBeUndefined();
  });
});

describe("the connection test", () => {
  const endpoint = "https://agents.example.com/ag-ui";

  test("an AG-UI stream is reported as working, with what came back", async () => {
    const result = await testAgentConnection(endpoint, {
      fetchImpl: async () =>
        new Response(
          'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toContain("RUN_STARTED");
  });

  test("a reachable address that is not an agent says so, and says what it sent", async () => {
    // The most common mistake: pointing at the app's home page instead of its AG-UI path.
    const result = await testAgentConnection(endpoint, {
      fetchImpl: async () =>
        new Response("<!doctype html><html><body>hello</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("text/html");
  });

  test("an authentication failure suggests the fix rather than the status code", async () => {
    const result = await testAgentConnection(endpoint, {
      fetchImpl: async () => new Response("no", { status: 401 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("key");
    }
  });

  test("an unreachable address explains the direction of the connection", async () => {
    // The server dials the agent, so the failure message names that direction.
    const result = await testAgentConnection(endpoint, {
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("reachable from");
  });

  test("the test refuses the addresses registration would refuse", async () => {
    // Otherwise the button is a way to probe the internal network from a form.
    let called = false;
    const result = await testAgentConnection("http://169.254.169.254/", {
      allowPrivateHosts: true,
      fetchImpl: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("headers are sent, so an agent behind a key can be tested", async () => {
    let seen: string | null = null;
    await testAgentConnection(endpoint, {
      headers: { authorization: "Bearer abc123" },
      fetchImpl: async (_url, init) => {
        seen = (init?.headers as Record<string, string>)?.authorization ?? null;
        return new Response('data: {"type":"RUN_STARTED"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    expect(seen).toBe("Bearer abc123");
  });
});

describe("Codex computer callbacks", () => {
  test("offers only the server-owned browser alias to Codex", () => {
    const frontendTools = [
      {
        name: "computer_navigate",
        description: "Browser-owned navigation",
        parameters: { type: "object" },
      },
      {
        name: "computer_request_help",
        description: "Wait for a person in the browser",
        parameters: { type: "object" },
      },
    ];
    const aliases = remoteComputerToolAliases(frontendTools);
    const tools = dynamicToolsOf({
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      context: [],
      tools: [...frontendTools, ...aliases],
      forwardedProps: {
        openbotDeploymentTools: aliases.map((tool) => tool.name),
      },
    });

    expect(aliases.map((tool) => tool.name)).toEqual([
      "openbot_computer_navigate",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "openbot_computer_navigate",
    ]);
  });

  test("routes aliased navigation through the governed computer gateway", async () => {
    const calls: Array<{
      botId: string;
      actorId: string;
      url: string;
    }> = [];
    const computerGateway = {
      navigate: async (botId: string, actor: { id: string }, url: string) => {
        calls.push({ botId, actorId: actor.id, url });
        return {
          url,
          title: "Example Domain",
          text: "Example Domain",
          truncated: false,
          elapsedMs: 12,
        };
      },
    } as unknown as ComputerGateway;
    const config = loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: "agent-secret" }),
    );
    const app = createApp(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      computerGateway,
    );
    const run = mintRunAssertion(
      {
        botId: "codex-assistant",
        actorId: "local-development",
        runId: "run-1",
      },
      config.keyEncryptionKey,
    );

    const response = await app.request(
      "http://openbot.test/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "agent-secret",
        },
        body: JSON.stringify({
          name: "openbot_computer_navigate",
          args: { url: "https://example.com/" },
          run,
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      text: string;
      isError: boolean;
    };
    expect(body.isError).toBe(false);
    expect(JSON.parse(body.text)).toMatchObject({
      ok: true,
      url: "https://example.com/",
      title: "Example Domain",
    });
    expect(calls).toEqual([
      {
        botId: "codex-assistant",
        actorId: "local-development",
        url: "https://example.com/",
      },
    ]);
  });
});

describe("the key a customer's agent sits behind", () => {
  const vaultRow = {
    id: "cred-1",
    kind: "agent" as const,
    provider: "ag-ui",
    keyId: "agent-1",
    metadata: { header: "Authorization" },
    encryptedValue: "",
    revokedAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test("it goes to the vault, and only a reference comes back", async () => {
    // The value must never be stored on the agent row: everything that can read an agent could then
    // read the key, and revoking it would mean editing the agent.
    let stored: { kind: string; keyId: string } | null = null;
    const auth = await storeAgentAuth({
      store: {
        create: async (value) => {
          stored = { kind: value.kind, keyId: value.keyId };
          return { ...vaultRow, encryptedValue: value.encryptedValue };
        },
        revoke: async () => new Date(),
      } as never,
      encryptionKey: TEST_KEY,
      agentId: "agent-1",
      header: "Authorization",
      value: "Bearer hunter2",
    });

    expect(stored).toEqual({ kind: "agent", keyId: "agent-1" });
    expect(auth).toEqual({ header: "Authorization", credentialId: "cred-1" });
    // The reference is all that touches the agent, and it carries no secret.
    expect(JSON.stringify(auth)).not.toContain("hunter2");
  });

  test("the value is encrypted at rest, not stored in the clear", async () => {
    let written = "";
    await storeAgentAuth({
      store: {
        create: async (value) => {
          written = value.encryptedValue;
          return vaultRow as never;
        },
        revoke: async () => new Date(),
      } as never,
      encryptionKey: TEST_KEY,
      agentId: "agent-1",
      header: "Authorization",
      value: "Bearer hunter2",
    });
    expect(written).not.toContain("hunter2");
    expect(written.length).toBeGreaterThan(0);
  });

  test("a revoked key sends nothing rather than falling back to no auth silently", async () => {
    // The run then fails at the agent with its own 401, which is the truthful outcome. Substituting
    // no auth would turn a revoked key into a confusing agent error with no mention of the key.
    const headers = await agentAuthHeaders({
      reader: {
        readSecret: async () => ({
          encryptedValue: "whatever",
          revokedAt: new Date(),
        }),
      },
      encryptionKey: TEST_KEY,
      auth: { header: "Authorization", credentialId: "cred-1" },
    });
    expect(headers).toBeUndefined();
  });

  test("an agent with no key sends no headers at all", async () => {
    expect(
      await agentAuthHeaders({
        reader: { readSecret: async () => null },
        encryptionKey: TEST_KEY,
        auth: null,
      }),
    ).toBeUndefined();
  });

  test("the form refuses a header name that is not a header name", () => {
    const base = {
      name: "Sales Bot",
      title: "Sales",
      roleDescription: "Answers questions about pricing.",
      visibility: "private",
    };
    // A newline here would let somebody inject a second header into every request this server makes.
    const parsed = parseAgentInput({
      ...base,
      auth: { header: "X-Bad\nInjected: yes", value: "abc" },
    });
    expect(parsed.ok).toBe(false);
  });

  test("an empty key is not a key, so saving an edit does not wipe one", () => {
    const parsed = parseAgentInput({
      name: "Sales Bot",
      title: "Sales",
      roleDescription: "Answers questions about pricing.",
      visibility: "private",
      auth: { header: "Authorization", value: "   " },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.auth).toBeUndefined();
  });
});

/**
 * The fetch a run is dialled with, rather than the check a registration passed.
 *
 * The address in the database was allowed once, by whatever rules were in force that day, and every
 * run afterwards dials it again. So this fetch re-asks the question on the way out: the stored
 * address is checked before the first byte, and each redirect is checked before it is followed.
 *
 * The second half is what a redirect does to the things the request is carrying. A hop that leaves
 * the host it was authorised for is a hop to somebody else, and everything on that request that
 * proves who we are, the customer's key in the headers and this deployment's own signed run in the
 * body, has to stop there.
 */
describe("dialling a stored agent endpoint", () => {
  /** A fetch that records what it was asked to do and answers however the test says. */
  function recorder(answers: Array<() => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer();
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  const redirectTo = (location: string) => () =>
    new Response(null, { status: 307, headers: { location } });
  const arrived = () => new Response("ok");

  /** What a run carries: the customer's key, and this deployment's statement of whose run it is. */
  const runRequest = {
    method: "POST",
    // Capitalised the way `@ag-ui/client` actually sends them, so a check keyed on the lower-cased
    // name is tested against the shape a run really arrives in rather than a tidier one.
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer customer-key",
      "X-Api-Key": "customer-key",
    },
    body: JSON.stringify({
      threadId: "t",
      forwardedProps: { openbotBotId: "risk", openbotRun: "signed.run.token" },
    }),
  };

  test("the stored address is checked again before it is dialled", async () => {
    // The row was written before this guard existed, or under an older rule. Checking only the
    // redirects leaves the one address that is dialled on every single run unchecked.
    const { calls, impl } = recorder([arrived]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await expect(
      dial("http://169.254.169.254/latest/meta-data/", runRequest),
    ).rejects.toThrow(/may not live there|refus/i);
    expect(calls.length).toBe(0);
  });

  /**
   * A refusal here is the one thing on this path an operator cannot otherwise find out about.
   *
   * The person who registered the agent learns immediately, because their run fails and says why. The
   * deployment learns nothing: a stored agent that quietly began redirecting to the metadata address
   * is exactly the event worth counting, and it is invisible in the trail unless the refusal writes a
   * row. So the fetch reports refusals rather than only throwing them, and the caller decides what
   * that means. The reason travels with it, because "an agent was refused" without which address and
   * why is a row nobody can act on.
   */
  test("reports a refused hop to its caller, with the address and the reason", async () => {
    const refusals: Array<{ address: string; reason: string }> = [];
    const { calls, impl } = recorder([
      redirectTo("http://169.254.169.254/latest/meta-data/"),
      arrived,
    ]);
    const dial = createAgentFetch({
      fetchImpl: impl,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    await expect(
      dial("https://agent.example.com/ag-ui", runRequest),
    ).rejects.toThrow(EndpointNotAllowedError);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.address).toBe(
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(refusals[0]?.reason).toMatch(/may not live there|refus/i);
    // Reported, and still not dialled. A row about a request that went out anyway would be worse
    // than no row at all.
    expect(calls).toHaveLength(1);
  });

  test("reports a stored address refused before the first byte", async () => {
    // The other refusal an operator wants counted, and the one with no person watching: this fires
    // on every run of an agent whose stored address stopped being acceptable.
    const refusals: Array<{ address: string; reason: string }> = [];
    const { calls, impl } = recorder([arrived]);
    const dial = createAgentFetch({
      fetchImpl: impl,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    await expect(
      dial("http://169.254.169.254/latest/meta-data/", runRequest),
    ).rejects.toThrow(EndpointNotAllowedError);

    expect(refusals).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("says nothing when nothing was refused", async () => {
    // The negative case, because a reporter that fires on a permitted hop would fill the trail with
    // rows about agents that are working.
    const refusals: unknown[] = [];
    const { impl } = recorder([
      redirectTo("https://agent.example.com/moved"),
      arrived,
    ]);
    const dial = createAgentFetch({
      fetchImpl: impl,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    await dial("https://agent.example.com/ag-ui", runRequest);

    expect(refusals).toHaveLength(0);
  });

  test("a hop to another host does not take the credentials with it", async () => {
    // What curl and a browser do, and for the reason they do it: the key was handed to us for one
    // host, and a redirect is that host naming a different one.
    const { calls, impl } = recorder([
      redirectTo("https://elsewhere.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    const response = await dial("https://agent.example.com/ag-ui", runRequest);
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);

    const first = new Headers(calls[0]?.init.headers);
    expect(first.get("authorization")).toBe("Bearer customer-key");

    const second = new Headers(calls[1]?.init.headers);
    expect(second.get("authorization")).toBeNull();
    expect(second.get("x-api-key")).toBeNull();
    // The protocol headers are not credentials, and an AG-UI POST without them is not an AG-UI POST.
    expect(second.get("content-type")).toBe("application/json");
    expect(second.get("accept")).toBe("text/event-stream");
  });

  test("a hop to another host does not take the signed run with it", async () => {
    // The run assertion is a bearer capability: whoever holds it can call back as this Bot, for this
    // person. It rides in the body, so stripping headers alone leaves the leak open.
    const { calls, impl } = recorder([
      redirectTo("https://elsewhere.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await dial("https://agent.example.com/ag-ui", runRequest);

    const forwarded = JSON.parse(String(calls[1]?.init.body)) as {
      threadId?: string;
      forwardedProps?: Record<string, unknown>;
    };
    expect(forwarded.forwardedProps?.openbotRun).toBeUndefined();
    // Only the credential is removed. The rest of the run is still the run.
    expect(forwarded.threadId).toBe("t");
    expect(forwarded.forwardedProps?.openbotBotId).toBe("risk");
  });

  test("a hop that stays on the same host keeps them", async () => {
    // An agent that redirects `/ag-ui` to `/ag-ui/` is the same agent, and stripping its own key
    // there would answer a working registration with a 401.
    const { calls, impl } = recorder([
      redirectTo("https://agent.example.com/ag-ui/"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await dial("https://agent.example.com/ag-ui", runRequest);

    const second = new Headers(calls[1]?.init.headers);
    expect(second.get("authorization")).toBe("Bearer customer-key");
    const forwarded = JSON.parse(String(calls[1]?.init.body)) as {
      forwardedProps?: Record<string, unknown>;
    };
    expect(forwarded.forwardedProps?.openbotRun).toBe("signed.run.token");
  });

  test("an upgrade from http to https on the same host keeps them", async () => {
    // The ordinary case a deployment behind a redirect actually has. Treating a scheme upgrade as a
    // different host would break it while protecting nothing: the credential ends up somewhere
    // strictly safer than it started.
    const { calls, impl } = recorder([
      redirectTo("https://agent.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await dial("http://agent.example.com/ag-ui", runRequest);

    const second = new Headers(calls[1]?.init.headers);
    expect(second.get("authorization")).toBe("Bearer customer-key");
  });

  test("a downgrade from https to http does not", async () => {
    // Same host, but the key would leave over a connection anybody on the path can read.
    const { calls, impl } = recorder([
      redirectTo("http://agent.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({
      fetchImpl: impl,
      allowPrivateHosts: false,
    });

    await dial("https://agent.example.com/ag-ui", runRequest);

    const second = new Headers(calls[1]?.init.headers);
    expect(second.get("authorization")).toBeNull();
  });

  test("a body this cannot read is not forwarded to another host at all", async () => {
    // Sanitising a body means understanding it. A stream is not a shape this deployment sends, so
    // the only two options are refusing an unreachable case or handing something unexamined to a
    // host the request was never authorised for.
    const { calls, impl } = recorder([
      redirectTo("https://elsewhere.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await expect(
      dial("https://agent.example.com/ag-ui", {
        method: "POST",
        body: new ReadableStream(),
      }),
    ).rejects.toThrow(/will not forward/i);
    expect(calls.length).toBe(1);
  });

  test("a body that is not the JSON it should be is not forwarded either", async () => {
    const { calls, impl } = recorder([
      redirectTo("https://elsewhere.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await expect(
      dial("https://agent.example.com/ag-ui", {
        method: "POST",
        body: "not json at all",
      }),
    ).rejects.toThrow(/will not forward/i);
    expect(calls.length).toBe(1);
  });

  test("credentials dropped on one hop do not come back on the next", async () => {
    // A chain that leaves the host and returns to it is not a way to get the key back: the request
    // has already been shown to somebody else.
    const { calls, impl } = recorder([
      redirectTo("https://elsewhere.example.com/one"),
      redirectTo("https://agent.example.com/ag-ui"),
      arrived,
    ]);
    const dial = createAgentFetch({ fetchImpl: impl });

    await dial("https://agent.example.com/ag-ui", runRequest);

    expect(calls.length).toBe(3);
    const third = new Headers(calls[2]?.init.headers);
    expect(third.get("authorization")).toBeNull();
  });
});

/**
 * Naming a private address instead of opening the network.
 *
 * `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` is a floor: it permits this deployment's whole network, to
 * browsing and to agent endpoints alike, and a production deployment refuses to start with it on.
 * That left bring-your-own-agent unusable in the image people are told to deploy, because a company's
 * own agent lives at an internal address. Naming the address is the narrow answer, and these are the
 * cases that decide whether it stays narrow.
 */
describe("private addresses named one at a time", () => {
  const named = (...hosts: string[]) => new Set(hosts);

  test("an unnamed private address is still refused", () => {
    const verdict = checkAgentEndpoint("http://10.0.0.42:9000/ag-ui", {
      allowedHosts: named("agents.internal"),
    });
    expect(verdict.allowed).toBeFalse();
  });

  test("a named private address is allowed", () => {
    const verdict = checkAgentEndpoint("http://10.0.0.42:9000/ag-ui", {
      allowedHosts: named("10.0.0.42:9000"),
    });
    expect(verdict.allowed).toBeTrue();
  });

  test("naming a host without a port covers its ports", () => {
    expect(
      checkAgentEndpoint("http://10.0.0.42:9000/ag-ui", {
        allowedHosts: named("10.0.0.42"),
      }).allowed,
    ).toBeTrue();
  });

  test("naming a host with a port pins that port", () => {
    // The narrow reading is the point: an operator who wrote a port meant that port.
    expect(
      checkAgentEndpoint("http://10.0.0.42:9999/ag-ui", {
        allowedHosts: named("10.0.0.42:9000"),
      }).allowed,
    ).toBeFalse();
  });

  test("the metadata address cannot be named back in", () => {
    /*
     * The property that makes this safe to ship. The never-allowed list is checked before the
     * private rule, so an address on it is not "refused for being private" and naming it changes
     * nothing. If this ever passes, the allowlist has become a way to hand a deployment's own cloud
     * credentials to anybody who can register an agent.
     */
    for (const address of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const verdict = checkAgentEndpoint(address, {
        allowedHosts: named(new URL(address).host, new URL(address).hostname),
      });
      expect(verdict.allowed).toBeFalse();
    }
  });

  test("a non-web address cannot be named back in either", () => {
    expect(
      checkAgentEndpoint("file:///etc/passwd", {
        allowedHosts: named("", "localhost"),
      }).allowed,
    ).toBeFalse();
  });

  test("naming nothing is the same as before", () => {
    expect(
      checkAgentEndpoint("http://10.0.0.42:9000/ag-ui", {
        allowedHosts: named(),
      }).allowed,
    ).toBeFalse();
    expect(
      checkAgentEndpoint("http://10.0.0.42:9000/ag-ui").allowed,
    ).toBeFalse();
  });

  test("a public address is unaffected by the list", () => {
    expect(
      checkAgentEndpoint("https://agent.example.com/ag-ui", {
        allowedHosts: named("10.0.0.42"),
      }).allowed,
    ).toBeTrue();
  });
});

/**
 * The named address, across a redirect.
 *
 * Registration and the hop go through the same check, so a name has to mean the same thing in both
 * places. If a hop ignored the list, a legitimately named agent could not redirect at all; if a hop
 * were more generous than registration, the redirect would be the way around it.
 */
describe("named addresses on a redirect hop", () => {
  const redirectingTo = (location: string): typeof fetch =>
    (async (input: string | URL | Request) => {
      const target = typeof input === "string" ? input : input.toString();
      return target.includes("/start")
        ? new Response(null, { status: 307, headers: { location } })
        : new Response("landed", { status: 200 });
    }) as unknown as typeof fetch;

  test("a hop to a named private address is followed", async () => {
    const dial = createAgentFetch({
      allowedHosts: new Set(["10.0.0.42:9000"]),
      fetchImpl: redirectingTo("http://10.0.0.42:9000/ag-ui"),
    });
    const response = await dial("https://agent.example.com/start");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("landed");
  });

  test("a hop to an unnamed private address is refused", async () => {
    const dial = createAgentFetch({
      allowedHosts: new Set(["10.0.0.42:9000"]),
      fetchImpl: redirectingTo("http://10.0.0.99:9000/ag-ui"),
    });
    await expect(dial("https://agent.example.com/start")).rejects.toThrow();
  });

  test("a hop to the metadata address is refused however the list is written", async () => {
    const dial = createAgentFetch({
      allowedHosts: new Set(["169.254.169.254"]),
      fetchImpl: redirectingTo("http://169.254.169.254/latest/meta-data/"),
    });
    await expect(dial("https://agent.example.com/start")).rejects.toThrow();
  });
});
