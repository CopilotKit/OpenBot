import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  dynamicToolsOf,
  OpenBotToolGateway,
  runAssertionOf,
  toolCatalogueFingerprint,
} from "../src/tools";

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [],
    context: [],
    tools: [],
    forwardedProps: {},
    ...overrides,
  };
}

describe("Codex dynamic tools", () => {
  test("exposes only deployment-owned tools and preserves their schema", () => {
    const tools = dynamicToolsOf(
      input({
        tools: [
          {
            name: "search_files",
            description: "Search Drive",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            name: "render_chart",
            description: "Browser-owned chart",
            parameters: { type: "object" },
          },
        ],
        forwardedProps: {
          openbotDeploymentTools: ["search_files", "missing", "search_files"],
          openbotRun: "signed-run",
        },
      }),
    );

    expect(tools).toEqual([
      {
        type: "function",
        name: "search_files",
        description: "Search Drive",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
  });

  test("rejects tool names the Codex dynamic-tool protocol cannot represent", () => {
    expect(() =>
      dynamicToolsOf(
        input({
          tools: [{ name: "unsafe tool", description: "No", parameters: {} }],
          forwardedProps: { openbotDeploymentTools: ["unsafe tool"] },
        }),
      ),
    ).toThrow("Responses-API safe");
  });

  test("reads the opaque signed run assertion without interpreting it", () => {
    expect(
      runAssertionOf(
        input({ forwardedProps: { openbotRun: "opaque.signature" } }),
      ),
    ).toBe("opaque.signature");
    expect(runAssertionOf(input())).toBe("");
  });

  test("fingerprints the complete catalogue without depending on key or tool order", () => {
    const first = [
      {
        type: "function" as const,
        name: "read_page",
        description: "Read the page",
        inputSchema: {
          required: ["url"],
          properties: { url: { type: "string" } },
          type: "object",
        },
      },
      {
        type: "function" as const,
        name: "click",
        description: "Click",
        inputSchema: { type: "object" },
      },
    ];
    const reordered = [
      first[1],
      {
        ...first[0],
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    ];

    expect(toolCatalogueFingerprint(reordered)).toBe(
      toolCatalogueFingerprint(first),
    );
    expect(
      toolCatalogueFingerprint([
        { ...first[0], description: "Read the current page" },
        first[1],
      ]),
    ).not.toBe(toolCatalogueFingerprint(first));
  });
});

describe("OpenBotToolGateway", () => {
  test("sends the signed run and agent credential to OpenBot", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = { url: String(url), init };
      return Response.json({ text: "three files", isError: false });
    }) as typeof fetch;
    const gateway = new OpenBotToolGateway({
      url: "http://openbot.test/api/agent-tools/call",
      token: "agent-secret",
      fetch: fakeFetch,
    });

    await expect(
      gateway.call("signed-run", "search_files", { query: "budget" }),
    ).resolves.toEqual({ text: "three files", success: true });
    expect(request?.url).toBe("http://openbot.test/api/agent-tools/call");
    expect(request?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-openbot-agent-token": "agent-secret",
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      name: "search_files",
      args: { query: "budget" },
      run: "signed-run",
    });
  });

  test("returns refusals to Codex as failed tool results", async () => {
    const deniedFetch = (async () =>
      Response.json(
        { error: "Policy denied this call." },
        { status: 403 },
      )) as unknown as typeof fetch;
    const denied = new OpenBotToolGateway({
      url: "http://openbot.test/tools",
      token: "token",
      fetch: deniedFetch,
    });

    await expect(denied.call("run", "delete_file", {})).resolves.toEqual({
      text: "Refused. Policy denied this call.",
      success: false,
    });
    await expect(
      new OpenBotToolGateway({
        url: "http://openbot.test/tools",
        token: "",
        fetch: deniedFetch,
      }).call("run", "delete_file", {}),
    ).resolves.toMatchObject({ success: false });
    await expect(denied.call("", "delete_file", {})).resolves.toMatchObject({
      success: false,
    });
  });
});
