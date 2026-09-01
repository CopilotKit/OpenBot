import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
  codexLaunchSpec,
  CodexAppServerClient,
  safeCodexEnvironment,
} from "../src/codex-client";
import type { CodexDynamicTool } from "../src/tools";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

const dynamicTool: CodexDynamicTool = {
  type: "function",
  name: "search_files",
  description: "Search files",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
};

class FakeAppServer {
  readonly messages: Message[] = [];
  readonly process: ChildProcessWithoutNullStreams;
  toolResponse: Record<string, unknown> | undefined;
  toolResponses: Record<string, unknown>[] = [];

  private readonly stdin = new PassThrough();
  private readonly stdout = new PassThrough();
  private readonly stderr = new PassThrough();

  constructor(
    private readonly turn:
      | "tool"
      | "native"
      | "duplicate"
      | "malformed"
      | "waiting"
      | "replay" = "tool",
  ) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdin = this.stdin;
    child.stdout = this.stdout;
    child.stderr = this.stderr;
    child.kill = () => {
      child.emit("exit", 0, null);
      return true;
    };
    this.process = child as unknown as ChildProcessWithoutNullStreams;

    const lines = createInterface({ input: this.stdin });
    lines.on("line", (line) => this.receive(JSON.parse(line) as Message));
  }

  private receive(message: Message): void {
    this.messages.push(message);
    if (
      typeof message.id === "string" &&
      message.id.startsWith("dynamic-tool-call") &&
      message.result
    ) {
      this.toolResponse = message.result;
      this.toolResponses.push(message.result);
      if (this.turn === "duplicate" && this.toolResponses.length === 1) {
        this.sendToolCall("dynamic-tool-call-duplicate");
        return;
      }
      this.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "codex-thread",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "I found three files.",
        },
      });
      this.send({
        method: "turn/completed",
        params: {
          threadId: "codex-thread",
          turn: { id: "turn-1", status: "completed" },
        },
      });
      return;
    }
    if (message.id === undefined || !message.method) return;

    switch (message.method) {
      case "initialize":
        this.result(message.id, {});
        break;
      case "account/read":
        this.result(message.id, {
          account: { type: "chatgpt", planType: "plus" },
        });
        break;
      case "config/read":
        this.result(message.id, {
          config: { mcp_servers: { existing_server: { command: "unsafe" } } },
        });
        break;
      case "thread/start":
        this.result(message.id, { thread: { id: "codex-thread" } });
        break;
      case "thread/resume":
        this.result(message.id, {
          thread: { id: String(message.params?.threadId) },
        });
        break;
      case "turn/start":
        if (this.turn === "replay") {
          this.send({
            method: "item/agentMessage/delta",
            params: {
              threadId: "codex-thread",
              turnId: "old-turn",
              itemId: "old-message",
              delta: "stale answer",
            },
          });
          this.send({
            method: "turn/completed",
            params: {
              threadId: "codex-thread",
              turn: { id: "old-turn", status: "completed" },
            },
          });
        }
        this.result(message.id, { turn: { id: "turn-1" } });
        queueMicrotask(() => {
          if (
            this.turn === "tool" ||
            this.turn === "duplicate" ||
            this.turn === "replay"
          ) {
            this.sendToolCall("dynamic-tool-call");
          } else if (this.turn === "malformed") {
            this.sendToolCall("dynamic-tool-call", []);
          } else if (this.turn === "native") {
            this.send({
              method: "item/started",
              params: {
                threadId: "codex-thread",
                turnId: "turn-1",
                item: { id: "command-1", type: "commandExecution" },
              },
            });
          }
        });
        break;
      case "turn/interrupt":
        this.result(message.id, {});
        break;
      default:
        this.result(message.id, {});
    }
  }

  private result(id: number | string, result: Record<string, unknown>): void {
    this.send({ id, result });
  }

  private sendToolCall(id: string, args: unknown = { query: "budget" }): void {
    this.send({
      id,
      method: "item/tool/call",
      params: {
        threadId: "codex-thread",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "search_files",
        arguments: args,
      },
    });
  }

  private send(message: Message): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("CodexAppServerClient", () => {
  test("resumes persistent threads and answers dynamic tool calls", async () => {
    const server = new FakeAppServer();
    const client = new CodexAppServerClient(() => server.process);
    await client.start();

    expect(client.accountSummary()).toEqual({
      authMode: "chatgpt",
      planType: "plus",
    });
    await expect(
      client.startThread("/workspace", "governed only", [dynamicTool]),
    ).resolves.toBe("codex-thread");
    await client.resumeThread("codex-thread", "/workspace", "governed only");

    const text: string[] = [];
    await client.runTurn("codex-thread", "/workspace", "Find budget", {
      onText(delta) {
        text.push(delta);
      },
      async onToolCall(callId, name, args) {
        expect(callId).toBe("call-1");
        expect(name).toBe("search_files");
        expect(args).toEqual({ query: "budget" });
        return { text: "three files", success: true };
      },
    });

    expect(text).toEqual(["I found three files."]);
    expect(server.toolResponse).toEqual({
      contentItems: [{ type: "inputText", text: "three files" }],
      success: true,
    });
    const initialize = server.messages.find(
      (message) => message.method === "initialize",
    );
    expect(initialize?.params?.capabilities).toEqual({ experimentalApi: true });
    const start = server.messages.find(
      (message) => message.method === "thread/start",
    );
    expect(start?.params?.dynamicTools).toEqual([dynamicTool]);
    expect(start?.params?.config).toMatchObject({
      mcp_servers: { existing_server: { enabled: false } },
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        in_app_browser: false,
        plugins: false,
        shell_tool: false,
        unified_exec: false,
        workspace_dependencies: false,
        multi_agent: false,
      },
      shell_environment_policy: { inherit: "none" },
      web_search: "disabled",
      apps: { _default: { enabled: false } },
      tools: { web_search: false, view_image: false },
    });
    const resume = server.messages.find(
      (message) => message.method === "thread/resume",
    );
    expect(resume?.params?.dynamicTools).toBeUndefined();
    const turn = server.messages.find(
      (message) => message.method === "turn/start",
    );
    expect(turn?.params?.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    client.stop();
  });

  test("disables native action surfaces before app-server starts", () => {
    const spec = codexLaunchSpec({
      CODEX_BINARY: "/opt/codex",
      CODEX_AGENT_WORKSPACE: "/srv/codex-workspace",
      CODEX_HOME: "/srv/codex-home",
      PATH: "/usr/bin",
      AGENT_TOOL_TOKEN: "openbot-tool-secret",
      MANAGED_AGENT_TOKEN: "openbot-agent-secret",
      OPENAI_API_KEY: "provider-secret",
    });

    expect(spec.binary).toBe("/opt/codex");
    expect(spec.cwd).toBe("/srv/codex-workspace");
    expect(spec.args).toContain('shell_environment_policy.inherit="none"');
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "browser_use",
      "computer_use",
      "in_app_browser",
      "workspace_dependencies",
    ]) {
      const position = spec.args.indexOf(feature);
      expect(position).toBeGreaterThan(0);
      expect(spec.args[position - 1]).toBe("--disable");
    }
    expect(spec.env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/srv/codex-home",
    });
  });

  test("never inherits OpenBot or provider credentials into Codex", () => {
    const environment = safeCodexEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/codex",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/etc/certs.pem",
      AGENT_TOOL_TOKEN: "tool-secret",
      MANAGED_AGENT_TOKEN: "managed-secret",
      COMPUTER_TOKEN: "computer-secret",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/codex",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/etc/certs.pem",
    });
    expect(JSON.stringify(environment)).not.toContain("secret");
  });

  test("ignores replayed prior-turn events before a resumed turn starts", async () => {
    const server = new FakeAppServer("replay");
    const client = new CodexAppServerClient(() => server.process);
    await client.start();
    await client.resumeThread("codex-thread", "/workspace", "governed only");
    const text: string[] = [];

    await client.runTurn("codex-thread", "/workspace", "Read the page", {
      onText(delta) {
        text.push(delta);
      },
      async onToolCall() {
        return { text: "Example Domain", success: true };
      },
    });

    expect(text).toEqual(["I found three files."]);
    client.stop();
  });

  test("interrupts a turn that attempts a Codex-native action", async () => {
    const server = new FakeAppServer("native");
    const client = new CodexAppServerClient(() => server.process);
    await client.start();
    await client.startThread("/workspace", "governed only", []);

    await expect(
      client.runTurn("codex-thread", "/workspace", "Run a command", {
        onText() {},
        async onToolCall() {
          return { text: "unreachable", success: false };
        },
      }),
    ).rejects.toThrow("OpenBot refused it");
    expect(
      server.messages.some((message) => message.method === "turn/interrupt"),
    ).toBe(true);
    client.stop();
  });

  test("executes a repeated dynamic-tool call id only once", async () => {
    const server = new FakeAppServer("duplicate");
    const client = new CodexAppServerClient(() => server.process);
    await client.start();
    await client.startThread("/workspace", "governed only", [dynamicTool]);
    let calls = 0;

    await client.runTurn("codex-thread", "/workspace", "Search once", {
      onText() {},
      async onToolCall() {
        calls += 1;
        return { text: "three files", success: true };
      },
    });

    expect(calls).toBe(1);
    expect(server.toolResponses).toHaveLength(2);
    expect(server.toolResponses[1]).toMatchObject({ success: false });
    client.stop();
  });

  test("interrupts Codex when OpenBot aborts the request", async () => {
    const server = new FakeAppServer("waiting");
    const client = new CodexAppServerClient(() => server.process);
    await client.start();
    await client.startThread("/workspace", "governed only", []);
    const abort = new AbortController();

    const turn = client.runTurn(
      "codex-thread",
      "/workspace",
      "Wait forever",
      {
        onText() {},
        async onToolCall() {
          return { text: "unreachable", success: false };
        },
      },
      abort.signal,
    );
    abort.abort();

    await expect(turn).rejects.toThrow("OpenBot ended the request");
    expect(
      server.messages.some((message) => message.method === "turn/interrupt"),
    ).toBe(true);
    client.stop();
  });

  test("does not coerce malformed tool arguments into an action", async () => {
    const server = new FakeAppServer("malformed");
    const client = new CodexAppServerClient(() => server.process);
    await client.start();
    await client.startThread("/workspace", "governed only", [dynamicTool]);
    let calls = 0;

    await client.runTurn("codex-thread", "/workspace", "Search once", {
      onText() {},
      async onToolCall() {
        calls += 1;
        return { text: "should not run", success: true };
      },
    });

    expect(calls).toBe(0);
    expect(server.toolResponses[0]).toMatchObject({ success: false });
    client.stop();
  });
});
