import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
  createAgentRoutes,
  parseAgentInput,
  parseConnectionHeaders,
} from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";

describe("parseConnectionHeaders", () => {
  test("absent headers stay absent", () => {
    expect(parseConnectionHeaders(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a valid map passes through", () => {
    expect(parseConnectionHeaders({ Authorization: "Bearer x" })).toEqual({
      ok: true,
      value: { Authorization: "Bearer x" },
    });
  });

  test.each([
    ["an array", ["Authorization"]],
    ["a string", "Authorization: Bearer x"],
    ["a number", 42],
    ["an array value", { Authorization: ["Bearer x"] }],
    ["a numeric value", { Authorization: 42 }],
    ["a nested value", { Authorization: { token: "x" } }],
    ["a null value", { Authorization: null }],
    // An object literal cannot carry its own __proto__: the syntax sets the prototype instead, so
    // the value travels through JSON text the way a real request body does.
    ["a __proto__ key", JSON.parse('{"__proto__":"polluted"}')],
    ["a constructor key", { constructor: "x" }],
    ["an invalid name", { "X Bad Name!": "x" }],
    ["an empty name", { "": "x" }],
  ])("rejects %s", (_name, input) => {
    const parsed = parseConnectionHeaders(input);
    expect(parsed.ok).toBe(false);
  });

  /*
   * A value the runtime will not put on the wire.
   *
   * `new Headers()` throws a TypeError for a line break, a NUL, and any code point above U+00FF,
   * measured on Bun 1.3.14. That throw comes out of the probe `fetch`, lands in the catch that is
   * there for a dead host, and is reported as an address this server could not reach — so a pasted
   * key with a wrapped line in it, or one carrying the en dash a document turned a hyphen into,
   * sends somebody looking at their tunnel and their firewall.
   */
  test.each([
    ["a newline in the value", "Bearer abc\ndef"],
    ["a carriage return in the value", "Bearer abc\rdef"],
    ["a NUL in the value", `Bearer abc${String.fromCharCode(0)}def`],
    ["a character above Latin-1", "Bearer — abc"],
  ])("rejects %s", (_name, value) => {
    const parsed = parseConnectionHeaders({ Authorization: value });
    expect(parsed.ok).toBe(false);
  });

  /*
   * The guard against over-correcting. Everything here is a value `new Headers()` accepts, so
   * refusing any of it would be taking away a header somebody's agent really wants.
   */
  test.each([
    ["a tab", "Bearer\tabc"],
    ["an inner space", "Bearer abc def"],
    ["a Latin-1 accent", "Bearer café"],
    ["punctuation", "Bearer abc-_.~+/=:;,@!$%^&*()[]{}"],
  ])("keeps %s", (_name, value) => {
    expect(parseConnectionHeaders({ Authorization: value })).toEqual({
      ok: true,
      value: { Authorization: value },
    });
  });
});

/*
 * The other half of the same form.
 *
 * The key stored on a Bot is typed into the same box as the one a connection test carries, and it is
 * sent as a header on every run rather than once. Accepted here, it is encrypted, stored, and then
 * throws inside `fetch` on every turn that Bot takes.
 */
describe("the key stored on a Bot", () => {
  const agent = (value: string) => ({
    name: "Helper",
    title: "Helper",
    roleDescription: "Helps.",
    visibility: "private",
    endpoint: "https://agent.example/ag-ui",
    auth: { header: "Authorization", value },
  });

  test("a key that cannot be sent as a header is refused", () => {
    const parsed = parseAgentInput(agent("Bearer abc\ndef"));
    expect(parsed.ok).toBe(false);
  });

  test("an ordinary key is still stored", () => {
    const parsed = parseAgentInput(agent("Bearer abc"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.auth).toEqual({
        header: "Authorization",
        value: "Bearer abc",
      });
    }
  });
});

describe("POST /test-connection header validation", () => {
  function appFor() {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "user-1",
        email: "user@openbot.test",
        role: "user",
      });
      await next();
    };
    return createAgentRoutes({} as never, requireUser, true);
  }

  test("invalid headers answer 400 without probing", async () => {
    const app = appFor();
    const response = await app.request("http://openbot.test/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://agent.example/ag-ui",
        headers: { Authorization: ["Bearer x"] },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/must be a string value/);
  });

  test("a __proto__ key answers 400", async () => {
    const app = appFor();
    // Built as text: an object literal cannot carry its own __proto__ through JSON.stringify, so
    // a real request carrying one arrives as raw JSON exactly like this.
    const rawBody = JSON.stringify({
      endpoint: "https://agent.example/ag-ui",
    }).replace(/}$/, ',"headers":{"__proto__":"polluted"}}');
    const response = await app.request("http://openbot.test/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });

    expect(response.status).toBe(400);
  });
});

/*
 * The failure as the person registering an agent meets it: a real server on the other end, a real
 * `fetch`, and a header value with a line break in it.
 */
describe("a header value that cannot be sent", () => {
  test("is refused before anything is dialled", async () => {
    let dialled = 0;
    const agent = Bun.serve({
      port: 0,
      fetch: () => {
        dialled += 1;
        return new Response(
          'event: RUN_STARTED\ndata: {"type":"RUN_STARTED"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    try {
      const requireUser: MiddlewareHandler<{
        Variables: AppVariables;
      }> = async (context, next) => {
        context.set("actor", {
          id: "user-1",
          email: "user@openbot.test",
          role: "user",
        });
        await next();
      };
      const app = createAgentRoutes({} as never, requireUser, true);

      const response = await app.request(
        "http://openbot.test/test-connection",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: `http://127.0.0.1:${agent.port}/ag-ui`,
            headers: { Authorization: "Bearer abc\ndef" },
          }),
        },
      );

      expect(response.status).toBe(400);
      // The agent is fine and was never asked. What is wrong is the value in the box, and that is
      // what the answer has to be about.
      expect(dialled).toBe(0);
      const body = (await response.json()) as {
        error?: string;
        reason?: string;
      };
      expect(body.reason).toBeUndefined();
      expect(body.error).toMatch(/line break|cannot be sent/i);
    } finally {
      agent.stop(true);
    }
  });
});
