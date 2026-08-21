import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { callTool, listTools } from "../src/plugins/mcp";

/**
 * The one door in this deployment that speaks MCP to somebody else's server, against something that
 * really speaks it.
 *
 * `mcp.ts` builds a real MCP client over Streamable HTTP and every tool a Bot uses goes through it,
 * so what it does with a reply is not a detail: the text lands in a model's context, the truncation
 * decides how much of a context window somebody else's server may spend, and `isError` decides
 * whether a Bot is told a tool failed or told nothing.
 *
 * None of that was tested. A stubbed fetch would prove we parse what we already believe the protocol
 * says, and every one of these would still pass if MCP changed underneath us or if we had misread it
 * in the first place. `@copilotkit/aimock` is ours, it is the org's deterministic backend for exactly
 * this, and it tracks the protocol as the protocol moves: using it here means OpenBot finds out about
 * a drift in the same week as everything else that depends on it, rather than in a customer's
 * integration.
 *
 * Offline and deterministic. No key, no network, no spend, same answer every run, which is what lets
 * it live in CI where a protocol contract most needs watching.
 */

const mock = new MCPMock();
let url = "";

/** Twenty thousand characters is the cap `mcp.ts` applies. This is comfortably past it. */
const LONG = "x".repeat(25_000);

/**
 * A real one-pixel PNG.
 *
 * The MCP SDK validates that image data is base64, so a placeholder like "iVBOR" fails the whole
 * call rather than the assertion. Worth knowing when writing a fixture: aimock will serve it.
 */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(async () => {
  mock
    .addTool({
      name: "search_issues",
      description: "Find issues matching a query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    })
    .onToolCall("search_issues", (args) => {
      const { query } = (args ?? {}) as { query?: string };
      return `Found 2 issues for ${query}`;
    })
    /*
     * Every tool carries an `inputSchema`, including the ones that take nothing.
     *
     * The official MCP SDK validates the whole listing and rejects it if any tool omits one, so a
     * single schemaless tool makes the server look completely broken rather than making that one
     * tool uncallable. Worth knowing: aimock will happily serve a tool without it.
     */
    .addTool({
      name: "long_answer",
      description: "Returns far too much.",
      inputSchema: { type: "object", properties: {} },
    })
    .onToolCall("long_answer", () => LONG)
    .addTool({
      name: "returns_an_image",
      description: "Not text.",
      inputSchema: { type: "object", properties: {} },
    })
    .onToolCall("returns_an_image", () => [
      { type: "image", data: PIXEL, mimeType: "image/png" },
    ])
    .addTool({
      name: "mixed_content",
      description: "Some text and something else.",
      inputSchema: { type: "object", properties: {} },
    })
    .onToolCall("mixed_content", () => [
      { type: "text", text: "here is the chart" },
      { type: "image", data: PIXEL, mimeType: "image/png" },
    ])
    .addTool({
      name: "always_fails",
      description: "Reports its own failure.",
      inputSchema: { type: "object", properties: {} },
    })
    .onToolCall("always_fails", () => {
      throw new Error("the vendor said no");
    });

  url = await mock.start();
});

afterAll(async () => {
  await mock.stop?.();
});

describe("listing what a server offers", () => {
  test("reads the tools, their descriptions and their schemas", async () => {
    const tools = await listTools({ url });

    const search = tools.find((tool) => tool.name === "search_issues");
    expect(search?.description).toBe("Find issues matching a query.");
    // The schema is handed to a model as the tool's contract, so an empty one is a tool the model
    // cannot call correctly rather than a cosmetic loss.
    expect(search?.inputSchema).toMatchObject({ type: "object" });
  });

  test("a tool with no description reads as empty rather than undefined", async () => {
    // The listing is projected into what a model sees. `undefined` there becomes the string
    // "undefined" in a prompt often enough to be worth pinning.
    const tools = await listTools({ url });
    const bare = tools.find((tool) => tool.name === "long_answer");

    expect(typeof bare?.description).toBe("string");
  });
});

describe("calling a tool", () => {
  test("sends the arguments and returns what came back", async () => {
    const result = await callTool({ url }, "search_issues", {
      query: "billing",
    });

    // The arguments really crossed the wire: the answer is derived from them by the far side.
    expect(result.text).toBe("Found 2 issues for billing");
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test("a long answer is cut, and says it was cut", async () => {
    /*
     * A tool result goes straight into a model's context, so an unbounded one is somebody else's
     * server deciding how much of our context window to spend. Truncated visibly, never silently: a
     * model that can see the cut can say the answer was incomplete.
     */
    const result = await callTool({ url }, "long_answer", {});

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(LONG.length);
  });

  test("a non-text part is named rather than dropped", async () => {
    // A model told "[image]" can say the tool returned an image. A model handed nothing concludes
    // the tool returned nothing, which is a different and wrong answer.
    const result = await callTool({ url }, "returns_an_image", {});

    expect(result.text).toContain("[image]");
  });

  test("text and a non-text part both survive", async () => {
    const result = await callTool({ url }, "mixed_content", {});

    expect(result.text).toContain("here is the chart");
    expect(result.text).toContain("[image]");
  });

  test("a server that reports its own failure is distinguished from one that did not answer", async () => {
    /*
     * `isError` is the difference between "the tool ran and refused" and "we could not reach it".
     * A Bot handed the first can explain itself; a Bot handed the second should retry or stop. The
     * protocol carries the distinction and it would be easy to flatten both into a throw.
     */
    const result = await callTool({ url }, "always_fails", {});

    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("a tool this server does not have fails rather than answering emptily", async () => {
    await expect(callTool({ url }, "no_such_tool", {})).rejects.toBeInstanceOf(
      Error,
    );
  });
});

describe("a server that cannot be reached", () => {
  test("fails rather than answering with nothing", async () => {
    // The case a stub cannot produce. A listing that returned `[]` for an unreachable server would
    // present a Bot as having no tools rather than as having a broken connector.
    await expect(
      listTools({ url: "http://127.0.0.1:9/mcp" }),
    ).rejects.toBeInstanceOf(Error);
  });
});
