import { describe, expect, test } from "bun:test";
import { agentAuthHeaders, storeAgentAuth } from "../src/agents/auth-header";
import { testAgentConnection } from "../src/agents/connection-test";
import { checkAgentEndpoint } from "../src/agents/endpoint";
import { parseAgentInput } from "../src/agents/routes";

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
