import { describe, expect, spyOn, test } from "bun:test";
import {
  ActionRegistry,
  type ChannelTool,
  type ChannelToolContext,
  defineChannelTool,
  FakeAdapter,
  InMemoryActionStore,
  MemoryStore,
  type PlatformAdapter,
  parseToolArgs,
  Thread,
  type ThreadDeps,
} from "@copilotkit/channels";
import {
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../src/computer/gateway";
import {
  createSlackComputerTools,
  type SlackComputerTool,
} from "../src/slack/computer-tools";
import {
  runWithSlackExecution,
  type SlackExecution,
} from "../src/slack/execution-context";

const STOPPED = { ok: false, stopped: true, reason: "Stopped." };
const UNAVAILABLE = {
  ok: false,
  reason: "The assistant's computer could not be reached.",
};
const CONTEXT_UNAVAILABLE = {
  ok: false,
  reason:
    "The computer action could not start because its Slack context was unavailable.",
};
const ACTION_FAILED = {
  ok: false,
  reason: "The computer action failed.",
};

type LoggedComputerFailure = {
  type?: unknown;
  error?: unknown;
  context?: {
    integration?: unknown;
    operation?: unknown;
    errorCategory?: unknown;
  };
  timestamp?: unknown;
};

function isLoggedComputerFailure(
  value: unknown,
): value is LoggedComputerFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "slack-computer-tool-failed"
  );
}

function capturedComputerFailures(calls: unknown[][]): LoggedComputerFailure[] {
  return calls.flatMap(([value]) => {
    try {
      const parsed: unknown = JSON.parse(String(value));
      return isLoggedComputerFailure(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type UploadArgs = Parameters<NonNullable<PlatformAdapter["postFile"]>>[1];
type UploadResult = Awaited<
  ReturnType<NonNullable<PlatformAdapter["postFile"]>>
>;

class FileAdapter extends FakeAdapter {
  readonly uploads: UploadArgs[] = [];
  readonly effects: Array<"message" | "file"> = [];
  result: UploadResult = { ok: true, fileId: "slack-file-1" };
  afterUpload?: () => void;
  beforePost?: () => void;
  postError?: unknown;
  postGate?: Promise<void>;

  override async post(...args: Parameters<PlatformAdapter["post"]>) {
    this.effects.push("message");
    this.beforePost?.();
    if (this.postError !== undefined) throw this.postError;
    await this.postGate;
    return super.post(...args);
  }

  async postFile(
    _target: Parameters<NonNullable<PlatformAdapter["postFile"]>>[0],
    args: UploadArgs,
  ): Promise<UploadResult> {
    this.effects.push("file");
    this.uploads.push(args);
    this.afterUpload?.();
    return this.result;
  }
}

function channelContext(
  adapter: FileAdapter,
  signal?: AbortSignal,
): ChannelToolContext {
  const actor = { id: "provider-U999", kind: "human" } as const;
  const user = { id: "u1", name: "OpenBot User" };
  const deps: ThreadDeps = {
    adapter,
    platform: "slack",
    replyTarget: { channelId: "C1", threadTs: "1.2" },
    conversationKey: "slack:T1:C1:1.2",
    channelName: "openbot",
    threadId: "channels-thread-1",
    registry: new ActionRegistry({ store: new InMemoryActionStore() }),
    agentFactory(id) {
      throw new Error(`Agent ${id} is not used by this test.`);
    },
    tools: new Map(),
    toolDescriptors: [],
    context: [],
    registerWaiter() {},
    interruptHandlers: new Map(),
    state: new MemoryStore(),
    user,
    actor,
  };
  return {
    thread: new Thread(deps),
    user,
    actor,
    signal,
    platform: "slack",
  };
}

function execution(overrides: Partial<SlackExecution> = {}): SlackExecution {
  return {
    actor: { id: "u1", role: "user" },
    applicationUser: { id: "u1", name: "OpenBot User" },
    provider: "slack",
    providerTenantId: "T1",
    providerConversationId: "C1",
    providerThreadId: "1.2",
    messageText: "Use the computer.",
    agentId: "risk",
    ...overrides,
  };
}

class FakeComputerGateway implements ComputerGateway {
  declare readonly provider: ComputerGateway["provider"];

  readonly navigateCalls: Parameters<ComputerGateway["navigate"]>[] = [];
  readonly screenshotCalls: Parameters<ComputerGateway["screenshot"]>[] = [];
  readonly snapshotCalls: Parameters<ComputerGateway["snapshot"]>[] = [];
  readonly readCalls: Parameters<ComputerGateway["read"]>[] = [];
  readonly clickCalls: Parameters<ComputerGateway["click"]>[] = [];
  readonly typeCalls: Parameters<ComputerGateway["type"]>[] = [];
  readonly keyCalls: Parameters<ComputerGateway["key"]>[] = [];
  readonly scrollCalls: Parameters<ComputerGateway["scroll"]>[] = [];
  readonly listFilesCalls: Parameters<ComputerGateway["listFiles"]>[] = [];
  readonly readFileCalls: Parameters<ComputerGateway["readFile"]>[] = [];
  readonly runCommandCalls: Parameters<ComputerGateway["runCommand"]>[] = [];
  readonly writeFileCalls: Parameters<ComputerGateway["writeFile"]>[] = [];
  readonly controlCalls: Parameters<ComputerGateway["control"]>[] = [];
  readonly requestHelpCalls: Parameters<ComputerGateway["requestHelp"]>[] = [];
  readonly requestSecretCalls: Parameters<ComputerGateway["requestSecret"]>[] =
    [];
  readonly releaseControlCalls: Parameters<
    ComputerGateway["releaseControl"]
  >[] = [];
  readonly cancelAssistanceCalls: Parameters<
    ComputerGateway["cancelAssistance"]
  >[] = [];
  readonly assistanceStatusCalls: Parameters<
    ComputerGateway["assistanceStatus"]
  >[] = [];
  nextError?: unknown;
  afterCall?: () => void;
  afterRequest?: () => void;
  requestError?: unknown;
  requestIdentityMismatch = false;
  releaseError?: unknown;
  cancelError?: unknown;
  cancelResult?: Awaited<ReturnType<ComputerGateway["cancelAssistance"]>>;
  assistanceStatusResult: Awaited<
    ReturnType<ComputerGateway["assistanceStatus"]>
  > = "completed";
  assistanceStatusResults?: Array<
    Awaited<ReturnType<ComputerGateway["assistanceStatus"]>>
  >;
  readFileResult: Awaited<ReturnType<ComputerGateway["readFile"]>> = {
    path: "reports/risk.txt",
    text: "Résumé 📊",
    truncated: false,
    bytes: 13,
  };

  private answer<T>(result: T): T {
    this.afterCall?.();
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }
    return result;
  }

  async locate(): Promise<never> {
    throw new Error("unused");
  }
  async status(): Promise<never> {
    throw new Error("unused");
  }
  async screenshot(...args: Parameters<ComputerGateway["screenshot"]>) {
    this.screenshotCalls.push(args);
    return this.answer({
      base64: "iVBORw0KGgo=",
      width: 1440,
      height: 900,
      capturedAt: "2026-08-28T12:00:00.000Z",
      url: "https://copilotkit.ai/",
    });
  }
  async snapshot(...args: Parameters<ComputerGateway["snapshot"]>) {
    this.snapshotCalls.push(args);
    return this.answer({
      snapshotId: 9,
      url: "https://example.com",
      title: "Example",
      elements: [],
      truncated: false,
    });
  }
  async read(...args: Parameters<ComputerGateway["read"]>) {
    this.readCalls.push(args);
    return this.answer({
      url: "https://example.com",
      title: "Example",
      text: "Page text",
      truncated: false,
    });
  }
  async navigate(...args: Parameters<ComputerGateway["navigate"]>) {
    this.navigateCalls.push(args);
    return this.answer({
      url: args[2],
      title: "Example",
      text: "Page text",
      truncated: false,
      elapsedMs: 4,
    });
  }
  async click(...args: Parameters<ComputerGateway["click"]>) {
    this.clickCalls.push(args);
    return this.answer({
      action: "click" as const,
      ref: args[2].ref,
      url: "https://example.com",
      elapsedMs: 2,
    });
  }
  async type(...args: Parameters<ComputerGateway["type"]>) {
    this.typeCalls.push(args);
    return this.answer({
      action: "type" as const,
      ref: args[2].ref,
      characters: args[2].text.length,
      submitted: args[2].submit,
      url: "https://example.com",
      elapsedMs: 2,
    });
  }
  async key(...args: Parameters<ComputerGateway["key"]>) {
    this.keyCalls.push(args);
    return this.answer({
      action: "key" as const,
      ref: args[2].ref,
      key: args[2].key,
      url: "https://example.com",
      elapsedMs: 2,
    });
  }
  async scroll(...args: Parameters<ComputerGateway["scroll"]>) {
    this.scrollCalls.push(args);
    return this.answer({
      action: "scroll" as const,
      deltaY: args[2].deltaY,
      url: "https://example.com",
      elapsedMs: 2,
    });
  }
  async readFile(...args: Parameters<ComputerGateway["readFile"]>) {
    this.readFileCalls.push(args);
    return this.answer(this.readFileResult);
  }
  async listFiles(...args: Parameters<ComputerGateway["listFiles"]>) {
    this.listFilesCalls.push(args);
    return this.answer({
      path: args[2].path ?? ".",
      entries: [{ path: "reports/risk.txt", kind: "file" as const, bytes: 13 }],
      truncated: false,
    });
  }
  async runCommand(...args: Parameters<ComputerGateway["runCommand"]>) {
    this.runCommandCalls.push(args);
    return this.answer({
      command: args[2].command,
      exitCode: 0,
      stdout: "done\n",
      stderr: "",
      truncated: false,
      timedOut: false,
      elapsedMs: 5,
    });
  }
  async writeFile(...args: Parameters<ComputerGateway["writeFile"]>) {
    this.writeFileCalls.push(args);
    return this.answer({
      path: args[2].path,
      bytes: new TextEncoder().encode(args[2].contents).byteLength,
      appended: args[2].append === true,
    });
  }
  async control(...args: Parameters<ComputerGateway["control"]>) {
    this.controlCalls.push(args);
    return {
      holder: "bot" as const,
      since: "2026-08-27T00:00:00.000Z",
      requested: false,
    };
  }
  async requestHelp(...args: Parameters<ComputerGateway["requestHelp"]>) {
    this.requestHelpCalls.push(args);
    this.afterRequest?.();
    if (this.requestError !== undefined) throw this.requestError;
    return {
      holder: "bot" as const,
      since: "2026-08-27T00:00:00.000Z",
      requested: true,
      helpRequestId: this.requestIdentityMismatch
        ? crypto.randomUUID()
        : args[3],
    };
  }
  async takeControl(): Promise<never> {
    throw new Error("unused");
  }
  async releaseControl(...args: Parameters<ComputerGateway["releaseControl"]>) {
    this.releaseControlCalls.push(args);
    if (this.releaseError !== undefined) throw this.releaseError;
    return {
      holder: "bot" as const,
      since: "2026-08-27T00:00:00.000Z",
      requested: false,
    };
  }
  async cancelAssistance(
    ...args: Parameters<ComputerGateway["cancelAssistance"]>
  ) {
    this.cancelAssistanceCalls.push(args);
    if (this.cancelError !== undefined) throw this.cancelError;
    return (
      this.cancelResult ?? {
        cancelled: true,
        status: "cancelled" as const,
        state: {
          holder: "bot" as const,
          since: "2026-08-27T00:00:00.000Z",
          requested: false,
        },
      }
    );
  }
  async assistanceStatus(
    ...args: Parameters<ComputerGateway["assistanceStatus"]>
  ) {
    this.assistanceStatusCalls.push(args);
    return this.assistanceStatusResults?.shift() ?? this.assistanceStatusResult;
  }
  async requestSecret(...args: Parameters<ComputerGateway["requestSecret"]>) {
    this.requestSecretCalls.push(args);
    this.afterRequest?.();
    if (this.requestError !== undefined) throw this.requestError;
    return {
      holder: "bot" as const,
      since: "2026-08-27T00:00:00.000Z",
      requested: false,
      secretWanted: args[2].label,
      secretRequestId: this.requestIdentityMismatch
        ? crypto.randomUUID()
        : args[3],
    };
  }
  async supplySecret(): Promise<never> {
    throw new Error("unused");
  }
  async humanInput(): Promise<never> {
    throw new Error("unused");
  }
  async computers(): Promise<never> {
    throw new Error("unused");
  }
  async stopComputer(): Promise<never> {
    throw new Error("unused");
  }
  async resetComputer(): Promise<never> {
    throw new Error("unused");
  }
}

function toolsByName(gateway: ComputerGateway) {
  return new Map(
    createSlackComputerTools(gateway).map((tool) => [tool.name, tool]),
  );
}

function toolsWithAssistance(gateway: ComputerGateway) {
  return new Map(
    createSlackComputerTools(gateway, {
      appUrl: "https://openbot.example",
      encryptionKey: "slack-assistance-key",
    }).map((tool) => [tool.name, tool]),
  );
}

async function invoke(
  tool: SlackComputerTool | ChannelTool,
  args: unknown,
  context: ChannelToolContext,
) {
  const parsed = await parseToolArgs(tool.parameters, args);
  if (!parsed.ok) throw new Error(parsed.error);
  return tool.handler(parsed.value, context);
}

function inSlack<T>(run: () => T, overrides: Partial<SlackExecution> = {}): T {
  return runWithSlackExecution(execution(overrides), run);
}

describe("Slack computer ChannelTools", () => {
  test("exposes every non-assistance web operation and Slack file sharing", () => {
    const names = [...toolsByName(new FakeComputerGateway()).keys()];
    expect(names).toEqual([
      "computer_navigate",
      "computer_open_and_share_screenshot",
      "computer_screenshot",
      "computer_read",
      "computer_snapshot",
      "computer_type",
      "computer_click",
      "computer_key",
      "computer_list_files",
      "computer_read_file",
      "computer_run_command",
      "computer_write_file",
      "computer_scroll",
      "computer_share_file",
    ]);
    expect(names).not.toContain("computer_request_help");
    expect(names).not.toContain("computer_request_secret");
  });

  test("adds web-parity assistance tools only when the secure handoff is configured", () => {
    expect([...toolsWithAssistance(new FakeComputerGateway()).keys()]).toEqual([
      ...toolsByName(new FakeComputerGateway()).keys(),
      "computer_request_help",
      "computer_request_secret",
    ]);
  });

  test("posts secure help and secret handoffs without refs, cookies, or plain private ids", async () => {
    const gateway = new FakeComputerGateway();
    const tools = toolsWithAssistance(gateway);
    const adapter = new FileAdapter();
    const context = channelContext(adapter);

    const [help, secret] = await inSlack(
      async () => [
        await invoke(
          tools.get("computer_request_help")!,
          { reason: "Please finish signing in." },
          context,
        ),
        await invoke(
          tools.get("computer_request_secret")!,
          { label: "one-time code", ref: "field-ref-private", snapshotId: 9 },
          context,
        ),
      ],
      { channelsThreadId: "channels-thread-private" },
    );

    const rendered = JSON.stringify(adapter.posted);
    expect(rendered).toContain("Please finish signing in.");
    expect(rendered).toContain("one-time code");
    expect(rendered).toContain("/assist?token=");
    expect(rendered).not.toMatch(
      /field-ref-private|session-cookie-private|channels-thread-private|provider-U999|"u1"|"risk"/,
    );
    expect(gateway.requestHelpCalls).toHaveLength(1);
    expect(gateway.requestHelpCalls[0]?.slice(0, 3)).toEqual([
      "risk",
      { id: "u1", userId: "u1" },
      "Please finish signing in.",
    ]);
    expect(gateway.requestSecretCalls).toHaveLength(1);
    expect(gateway.requestSecretCalls[0]?.slice(0, 3)).toEqual([
      "risk",
      { id: "u1", userId: "u1" },
      { label: "one-time code", ref: "field-ref-private", snapshotId: 9 },
    ]);
    for (const requestId of [
      gateway.requestHelpCalls[0]?.[3],
      gateway.requestSecretCalls[0]?.[3],
    ]) {
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(rendered).not.toContain(requestId as string);
    }
    expect(help).toMatchObject({
      ok: true,
      result: expect.stringContaining("handed control back"),
    });
    expect(secret).toMatchObject({
      ok: true,
      result: expect.stringContaining("you were not told what it is"),
    });
  });

  test("validates the secure handoff before creating a help request", async () => {
    const gateway = new FakeComputerGateway();
    const tool = createSlackComputerTools(gateway, {
      appUrl: "http://not-loopback.example",
      encryptionKey: "slack-assistance-key",
    }).find((candidate) => candidate.name === "computer_request_help")!;

    const result = await inSlack(
      () =>
        invoke(
          tool,
          { reason: "Please sign in." },
          channelContext(new FileAdapter()),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(gateway.requestHelpCalls).toEqual([]);
    expect(result).toEqual(ACTION_FAILED);
  });

  for (const toolName of [
    "computer_request_help",
    "computer_request_secret",
  ] as const) {
    const args =
      toolName === "computer_request_help"
        ? { reason: "Please sign in." }
        : { label: "one-time code", ref: "e9", snapshotId: 9 };

    test(`${toolName} stops before committing when already aborted`, async () => {
      const gateway = new FakeComputerGateway();
      const controller = new AbortController();
      controller.abort();
      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get(toolName)!,
            args,
            channelContext(new FileAdapter(), controller.signal),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      expect(result).toEqual(STOPPED);
      expect(gateway.requestHelpCalls).toEqual([]);
      expect(gateway.requestSecretCalls).toEqual([]);
      expect(gateway.cancelAssistanceCalls).toEqual([]);
      expect(gateway.releaseControlCalls).toEqual([]);
    });

    test(`${toolName} clears its committed request when Slack delivery fails`, async () => {
      const gateway = new FakeComputerGateway();
      gateway.assistanceStatusResult = "pending";
      const adapter = new FileAdapter();
      adapter.postError = new Error("Slack unavailable");
      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get(toolName)!,
            args,
            channelContext(adapter),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      const requestCall =
        toolName === "computer_request_help"
          ? gateway.requestHelpCalls[0]
          : gateway.requestSecretCalls[0];
      const requestId = requestCall?.at(-1);
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(gateway.cancelAssistanceCalls).toEqual([
        ["risk", { id: "u1", userId: "u1" }, requestId, expect.anything()],
      ]);
      expect(gateway.releaseControlCalls).toEqual([]);
      expect(result).toEqual({
        ok: false,
        reason:
          "The Slack handoff could not be delivered. Its OpenBot assistance request was cleared; ask again if help is still needed.",
      });
    });

    test(`${toolName} conditionally clears a possibly-committed request failure`, async () => {
      const gateway = new FakeComputerGateway();
      gateway.assistanceStatusResult = "unknown";
      gateway.requestError = new Error("audit failed after transport commit");

      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get(toolName)!,
            args,
            channelContext(new FileAdapter()),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      const requestId = (
        toolName === "computer_request_help"
          ? gateway.requestHelpCalls[0]
          : gateway.requestSecretCalls[0]
      )?.at(-1);
      expect(gateway.cancelAssistanceCalls[0]?.[2]).toBe(requestId);
      expect(gateway.releaseControlCalls).toEqual([]);
      expect(result).toEqual({
        ok: false,
        reason:
          "The OpenBot assistance request could not be created safely. Its exact request generation is no longer pending; ask again if help is still needed.",
      });
    });

    test(`${toolName} refuses delivery when the computer does not confirm its request identity`, async () => {
      const gateway = new FakeComputerGateway();
      gateway.requestIdentityMismatch = true;
      const adapter = new FileAdapter();

      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get(toolName)!,
            args,
            channelContext(adapter),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      expect(adapter.posted).toEqual([]);
      expect(gateway.cancelAssistanceCalls).toEqual([]);
      expect(result).toEqual({
        ok: false,
        assistanceMayBePending: true,
        reason:
          "The Slack assistance flow could not be completed, and its OpenBot assistance request may still be pending. Open the coworker directly to clear it before asking again.",
      });
    });

    test(`${toolName} compensates when Stop races immediately after request commit`, async () => {
      const gateway = new FakeComputerGateway();
      gateway.assistanceStatusResult = "pending";
      const controller = new AbortController();
      gateway.afterRequest = () => controller.abort();
      const adapter = new FileAdapter();
      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get(toolName)!,
            args,
            channelContext(adapter, controller.signal),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      expect(adapter.posted).toEqual([]);
      expect(gateway.cancelAssistanceCalls).toHaveLength(1);
      expect(gateway.cancelAssistanceCalls[0]?.[2]).toBe(
        (toolName === "computer_request_help"
          ? gateway.requestHelpCalls[0]
          : gateway.requestSecretCalls[0]
        )?.at(-1),
      );
      expect(gateway.releaseControlCalls).toEqual([]);
      expect(result).toEqual(STOPPED);
    });
  }

  test("reports a possibly-live request when Slack delivery and compensation both fail", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "pending";
    gateway.cancelError = new Error("computer unavailable");
    const adapter = new FileAdapter();
    adapter.postError = new Error("Slack unavailable");

    const result = await inSlack(
      () =>
        invoke(
          toolsWithAssistance(gateway).get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(result).toEqual({
      ok: false,
      assistanceMayBePending: true,
      reason:
        "The Slack assistance flow could not be completed, and its OpenBot assistance request may still be pending. Open the coworker directly to clear it before asking again.",
    });
  });

  test("does not report cleanup when cancellation still returns the exact request", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "pending";
    const adapter = new FileAdapter();
    adapter.postError = new Error("Slack unavailable");
    gateway.cancelResult = {
      cancelled: false,
      status: "pending",
      state: {
        holder: "bot",
        since: "2026-08-27T00:00:00.000Z",
        requested: true,
        helpRequestId: "filled-after-request",
      },
    };
    gateway.cancelAssistance = async (...args) => {
      gateway.cancelAssistanceCalls.push(args);
      return {
        ...gateway.cancelResult!,
        state: { ...gateway.cancelResult!.state, helpRequestId: args[2] },
      };
    };

    const result = await inSlack(
      () =>
        invoke(
          toolsWithAssistance(gateway).get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(result).toEqual({
      ok: false,
      assistanceMayBePending: true,
      reason:
        "The Slack assistance flow could not be completed, and its OpenBot assistance request may still be pending. Open the coworker directly to clear it before asking again.",
    });
  });

  test("does not cancel an exact request while a person is driving", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "human";
    const controller = new AbortController();
    gateway.afterRequest = () => controller.abort();

    const result = await inSlack(
      () =>
        invoke(
          toolsWithAssistance(gateway).get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(new FileAdapter(), controller.signal),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(gateway.cancelAssistanceCalls).toEqual([]);
    expect(result).toEqual({
      ok: false,
      assistanceMayBePending: true,
      reason:
        "The Slack assistance flow could not be completed, and its OpenBot assistance request may still be pending. Open the coworker directly to clear it before asking again.",
    });
  });

  test("uses one deadline and never posts an already-expired assistance link", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "pending";
    let now = 0;
    gateway.afterRequest = () => {
      now = 10 * 60_000;
    };
    const adapter = new FileAdapter();
    const tools = new Map(
      createSlackComputerTools(gateway, {
        appUrl: "https://openbot.example",
        encryptionKey: "slack-assistance-key",
        now: () => now,
      }).map((tool) => [tool.name, tool]),
    );

    await inSlack(
      () =>
        invoke(
          tools.get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(adapter.posted).toEqual([]);
    expect(gateway.cancelAssistanceCalls).toHaveLength(1);
  });

  for (const toolName of [
    "computer_request_help",
    "computer_request_secret",
  ] as const) {
    test(`${toolName} reports a late exact completion that wins the deadline race`, async () => {
      const gateway = new FakeComputerGateway();
      let now = 0;
      gateway.afterRequest = () => {
        now = 10 * 60_000;
      };
      gateway.assistanceStatusResult = "completed";
      const tools = new Map(
        createSlackComputerTools(gateway, {
          appUrl: "https://openbot.example",
          encryptionKey: "slack-assistance-key",
          now: () => now,
        }).map((tool) => [tool.name, tool]),
      );

      const result = await inSlack(
        () =>
          invoke(
            tools.get(toolName)!,
            toolName === "computer_request_help"
              ? { reason: "Please sign in." }
              : { label: "one-time code", ref: "e9", snapshotId: 9 },
            channelContext(new FileAdapter()),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      expect(result).toMatchObject({
        ok: true,
        result: expect.stringContaining(
          toolName === "computer_request_help"
            ? "handed control back"
            : "you were not told what it is",
        ),
      });
      expect(gateway.cancelAssistanceCalls).toEqual([]);
    });
  }

  test("a completed request wins a Slack post failure and cancellation race", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "completed";
    const adapter = new FileAdapter();
    adapter.postError = new Error("Slack unavailable after human completion");

    const result = await inSlack(
      () =>
        invoke(
          toolsWithAssistance(gateway).get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(result).toMatchObject({
      ok: true,
      result: expect.stringContaining("handed control back"),
    });
    expect(gateway.cancelAssistanceCalls).toEqual([]);
  });

  test("completion between the status read and conditional cancel wins the race", async () => {
    const gateway = new FakeComputerGateway();
    gateway.assistanceStatusResult = "pending";
    gateway.cancelResult = {
      cancelled: false,
      status: "completed",
      state: {
        holder: "bot",
        since: "2026-08-27T00:00:00.000Z",
        requested: false,
      },
    };
    const adapter = new FileAdapter();
    adapter.postError = new Error("Slack unavailable during handoff");

    const result = await inSlack(
      () =>
        invoke(
          toolsWithAssistance(gateway).get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(result).toMatchObject({
      ok: true,
      result: expect.stringContaining("handed control back"),
    });
    expect(gateway.cancelAssistanceCalls).toHaveLength(1);
  });

  test("a hung Slack post gets only the remainder of the original deadline", async () => {
    const gateway = new FakeComputerGateway();
    let now = 0;
    gateway.afterRequest = () => {
      now = 10 * 60_000 - 2;
    };
    const adapter = new FileAdapter();
    adapter.postGate = new Promise(() => undefined);
    const tools = new Map(
      createSlackComputerTools(gateway, {
        appUrl: "https://openbot.example",
        encryptionKey: "slack-assistance-key",
        now: () => now,
      }).map((tool) => [tool.name, tool]),
    );

    const result = await inSlack(
      () =>
        invoke(
          tools.get("computer_request_help")!,
          { reason: "Please sign in." },
          channelContext(adapter),
        ),
      { channelsThreadId: "channels-thread-private" },
    );

    expect(result).toMatchObject({
      ok: false,
      deliveryMayBePending: true,
      assistanceMayBePending: true,
    });
    expect(gateway.cancelAssistanceCalls).toEqual([]);
  });

  for (const [status, expected] of [
    [
      "superseded",
      {
        ok: false,
        reason:
          "This exact OpenBot assistance request was replaced by a newer request and did not complete.",
      },
    ],
    [
      "cancelled",
      {
        ok: false,
        reason:
          "This exact OpenBot assistance request was already cancelled. Ask again only if help is still needed.",
      },
    ],
    [
      "expired",
      {
        ok: false,
        reason:
          "This exact OpenBot assistance request expired without completion. Ask again only if help is still needed.",
      },
    ],
    [
      "unknown",
      {
        ok: false,
        assistanceMayBePending: true,
        reason:
          "OpenBot no longer knows the exact assistance request outcome. Check the coworker before asking again.",
      },
    ],
  ] as const) {
    test(`reports an exact ${status} generation without claiming human completion`, async () => {
      const gateway = new FakeComputerGateway();
      gateway.assistanceStatusResult = status;
      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get("computer_request_help")!,
            { reason: "Please sign in." },
            channelContext(new FileAdapter()),
          ),
        { channelsThreadId: "channels-thread-private" },
      );
      expect(result).toEqual(expected);
      expect(gateway.cancelAssistanceCalls).toEqual([]);
    });
  }

  for (const lateOutcome of ["resolve", "reject"] as const) {
    test(`leaves an unknown Slack delivery untouched when posting later ${lateOutcome}s`, async () => {
      const gateway = new FakeComputerGateway();
      const controller = new AbortController();
      const gate = deferred<void>();
      const adapter = new FileAdapter();
      adapter.postGate = gate.promise;
      adapter.beforePost = () => controller.abort();

      const result = await inSlack(
        () =>
          invoke(
            toolsWithAssistance(gateway).get("computer_request_help")!,
            { reason: "Please sign in." },
            channelContext(adapter, controller.signal),
          ),
        { channelsThreadId: "channels-thread-private" },
      );

      expect(result).toEqual({
        ok: false,
        deliveryMayBePending: true,
        assistanceMayBePending: true,
        reason:
          "Slack may still deliver the secure assistance link, and its OpenBot request is still pending. Do not send another request until this one is checked.",
      });
      expect(gateway.cancelAssistanceCalls).toEqual([]);
      expect(gateway.releaseControlCalls).toEqual([]);

      if (lateOutcome === "resolve") gate.resolve();
      else gate.reject(new Error("late Slack rejection"));
      await Promise.resolve();
      await Promise.resolve();
      expect(adapter.posted.length).toBe(lateOutcome === "resolve" ? 1 : 0);
      expect(gateway.cancelAssistanceCalls).toEqual([]);
    });
  }

  test("passes the pinned coworker, linked actor, parsed click input, and signal", async () => {
    const gateway = new FakeComputerGateway();
    const tools = toolsByName(gateway);
    const signal = new AbortController().signal;

    const result = await inSlack(() =>
      invoke(
        tools.get("computer_click")!,
        { ref: "e4", snapshotId: 9, ignored: "removed by Zod" },
        channelContext(new FileAdapter(), signal),
      ),
    );

    expect(gateway.clickCalls).toEqual([
      [
        "risk",
        { id: "u1", userId: "u1" },
        { ref: "e4", snapshotId: 9 },
        signal,
      ],
    ]);
    expect(result).toMatchObject({ ok: true, action: "click", ref: "e4" });
  });

  test("calls each matching gateway method once with its exact current signature", async () => {
    const gateway = new FakeComputerGateway();
    const tools = toolsByName(gateway);
    const adapter = new FileAdapter();
    const signal = new AbortController().signal;
    const context = channelContext(adapter, signal);
    const actor = { id: "u1", userId: "u1" };

    await inSlack(async () => {
      await invoke(
        tools.get("computer_navigate")!,
        { url: "https://example.com" },
        context,
      );
      await invoke(tools.get("computer_read")!, {}, context);
      await invoke(tools.get("computer_snapshot")!, {}, context);
      await invoke(
        tools.get("computer_type")!,
        { ref: "e2", snapshotId: 9, text: "hello", submit: true },
        context,
      );
      await invoke(
        tools.get("computer_key")!,
        { key: "Enter", ref: "e2", snapshotId: 9 },
        context,
      );
      await invoke(tools.get("computer_scroll")!, { deltaY: -300 }, context);
      await invoke(
        tools.get("computer_list_files")!,
        { path: "reports" },
        context,
      );
      await invoke(
        tools.get("computer_read_file")!,
        { path: "reports/risk.txt" },
        context,
      );
      await invoke(
        tools.get("computer_run_command")!,
        { command: "wc -l risk.txt" },
        context,
      );
      await invoke(
        tools.get("computer_write_file")!,
        { path: "notes.txt", contents: "hello", append: true },
        context,
      );
    });

    expect(gateway.navigateCalls).toEqual([
      ["risk", actor, "https://example.com"],
    ]);
    expect(gateway.readCalls).toEqual([["risk"]]);
    expect(gateway.snapshotCalls).toEqual([["risk"]]);
    expect(gateway.typeCalls).toEqual([
      [
        "risk",
        actor,
        { ref: "e2", snapshotId: 9, text: "hello", submit: true },
        signal,
      ],
    ]);
    expect(gateway.keyCalls).toEqual([
      ["risk", actor, { key: "Enter", ref: "e2", snapshotId: 9 }, signal],
    ]);
    expect(gateway.scrollCalls).toEqual([["risk", actor, { deltaY: -300 }]]);
    expect(gateway.listFilesCalls).toEqual([
      ["risk", actor, { path: "reports" }],
    ]);
    expect(gateway.readFileCalls).toEqual([
      ["risk", actor, { path: "reports/risk.txt" }],
    ]);
    expect(gateway.runCommandCalls).toEqual([
      ["risk", actor, { command: "wc -l risk.txt" }, signal],
    ]);
    expect(gateway.writeFileCalls).toEqual([
      ["risk", actor, { path: "notes.txt", contents: "hello", append: true }],
    ]);
  });

  test("fails safely outside Slack execution without touching the gateway", async () => {
    const gateway = new FakeComputerGateway();
    const tool = toolsByName(gateway).get("computer_click")!;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await invoke(
        tool,
        { ref: "e4", snapshotId: 9 },
        channelContext(new FileAdapter()),
      );
      expect(result).toEqual(CONTEXT_UNAVAILABLE);
      const event = capturedComputerFailures(logged.mock.calls).find(
        ({ context }) => context?.errorCategory === "execution-context",
      );
      expect(event).toMatchObject({
        type: "slack-computer-tool-failed",
        error: "SlackComputerContextError",
        context: {
          integration: "slack",
          operation: "computer-tool",
          errorCategory: "execution-context",
        },
      });
      expect(
        Number.isNaN(
          Date.parse(
            typeof event?.timestamp === "string" ? event.timestamp : "",
          ),
        ),
      ).toBe(false);
      expect(gateway.clickCalls).toHaveLength(0);
    } finally {
      logged.mockRestore();
    }
  });

  test("fails safely when no coworker is pinned without touching the gateway", async () => {
    const gateway = new FakeComputerGateway();
    const tool = toolsByName(gateway).get("computer_click")!;
    const result = await inSlack(
      () =>
        invoke(
          tool,
          { ref: "e4", snapshotId: 9 },
          channelContext(new FileAdapter()),
        ),
      { agentId: undefined },
    );
    expect(result).toEqual(CONTEXT_UNAVAILABLE);
    expect(gateway.clickCalls).toHaveLength(0);
  });

  test("normalizes every public gateway domain error by class", async () => {
    const gateway = new FakeComputerGateway();
    const tool = toolsByName(gateway).get("computer_click")!;
    const context = channelContext(new FileAdapter());
    const cases = [
      {
        error: new ActionRefusedError("Blocked by policy.", "deny-payments"),
        expected: {
          ok: false,
          refused: true,
          reason: "Blocked by policy.",
          rule: "deny-payments",
        },
      },
      {
        error: new StaleSnapshotError("Take a new snapshot."),
        expected: {
          ok: false,
          staleRefs: true,
          reason: "Take a new snapshot.",
        },
      },
      {
        error: new ElementNotFoundError("That element is gone."),
        expected: {
          ok: false,
          staleRefs: true,
          reason: "That element is gone.",
        },
      },
      {
        error: new HumanHasControlError("A person is driving."),
        expected: {
          ok: false,
          humanHasControl: true,
          reason: "A person is driving.",
        },
      },
      {
        error: new NavigationRefusedError("Private hosts are not allowed."),
        expected: {
          ok: false,
          refused: true,
          reason: "Private hosts are not allowed.",
        },
      },
      {
        error: new WorkspaceRefusedError("That path leaves the workspace."),
        expected: {
          ok: false,
          refused: true,
          reason: "That path leaves the workspace.",
        },
      },
      {
        error: new WorkspaceRequestError("There is no file at notes.md."),
        expected: {
          ok: false,
          reason: "There is no file at notes.md.",
        },
      },
      { error: new DOMException("cancelled", "AbortError"), expected: STOPPED },
    ];

    for (const item of cases) {
      gateway.nextError = item.error;
      const result = await inSlack(() =>
        invoke(tool, { ref: "e4", snapshotId: 9 }, context),
      );
      expect(result).toEqual(item.expected);
    }
    expect(gateway.clickCalls).toHaveLength(cases.length);
  });

  test("maps an aborted transport ComputerUnavailableError to stopped", async () => {
    const gateway = new FakeComputerGateway();
    const controller = new AbortController();
    gateway.afterCall = () => controller.abort();
    gateway.nextError = new ComputerUnavailableError(
      "The assistant's computer is not running.",
    );

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_click")!,
        { ref: "e4", snapshotId: 9 },
        channelContext(new FileAdapter(), controller.signal),
      ),
    );

    expect(result).toEqual(STOPPED);
    expect(gateway.clickCalls).toHaveLength(1);
  });

  test("does not trust an ordinary Error renamed AbortError", async () => {
    const gateway = new FakeComputerGateway();
    const renamed = new Error("internal detail");
    renamed.name = "AbortError";
    gateway.nextError = renamed;

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_click")!,
        { ref: "e4", snapshotId: 9 },
        channelContext(new FileAdapter()),
      ),
    );

    expect(result).toEqual(ACTION_FAILED);
  });

  test("hides unavailable and unknown error details and never retries", async () => {
    const gateway = new FakeComputerGateway();
    const tool = toolsByName(gateway).get("computer_click")!;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const unknown = new Error("socket token=secret internal stack detail");
    unknown.name = "token=secret";
    try {
      for (const error of [
        new ComputerUnavailableError("host token=secret did not answer"),
        unknown,
      ]) {
        gateway.nextError = error;
        const result = await inSlack(() =>
          invoke(
            tool,
            { ref: "e4", snapshotId: 9 },
            channelContext(new FileAdapter()),
          ),
        );
        expect(result).toEqual(
          error instanceof ComputerUnavailableError
            ? UNAVAILABLE
            : ACTION_FAILED,
        );
        expect(JSON.stringify(result)).not.toContain("secret");
      }
      const failures = capturedComputerFailures(logged.mock.calls);
      expect(JSON.stringify(failures)).not.toContain("secret");
      const event = failures.find(
        ({ context, error }) =>
          context?.errorCategory === "unknown" && error === "UnknownError",
      );
      expect(event).toMatchObject({
        type: "slack-computer-tool-failed",
        error: "UnknownError",
        context: {
          integration: "slack",
          operation: "computer-tool",
          errorCategory: "unknown",
        },
      });
      expect(
        Number.isNaN(
          Date.parse(
            typeof event?.timestamp === "string" ? event.timestamp : "",
          ),
        ),
      ).toBe(false);
    } finally {
      logged.mockRestore();
    }
    expect(gateway.clickCalls).toHaveLength(2);
  });

  test("checks abort before and after non-cancellable read-only gateway methods", async () => {
    const gateway = new FakeComputerGateway();
    const tool = toolsByName(gateway).get("computer_read")!;
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    const before = await inSlack(() =>
      invoke(
        tool,
        {},
        channelContext(new FileAdapter(), alreadyStopped.signal),
      ),
    );
    expect(before).toEqual(STOPPED);
    expect(gateway.readCalls).toHaveLength(0);

    const stoppedAfter = new AbortController();
    gateway.afterCall = () => stoppedAfter.abort();
    const after = await inSlack(() =>
      invoke(tool, {}, channelContext(new FileAdapter(), stoppedAfter.signal)),
    );
    expect(after).toEqual(STOPPED);
    expect(gateway.readCalls).toHaveLength(1);
  });

  test("reports successful non-cancellable mutators truthfully after their commit point", async () => {
    const cases = [
      {
        name: "computer_navigate",
        input: { url: "https://example.com" },
        assert(result: unknown) {
          expect(result).toMatchObject({
            ok: true,
            url: "https://example.com",
          });
        },
      },
      {
        name: "computer_scroll",
        input: { deltaY: 300 },
        assert(result: unknown) {
          expect(result).toMatchObject({ ok: true, action: "scroll" });
        },
      },
      {
        name: "computer_write_file",
        input: { path: "log.txt", contents: "next\n", append: true },
        assert(result: unknown) {
          expect(result).toMatchObject({ ok: true, appended: true });
        },
      },
    ];

    for (const item of cases) {
      const gateway = new FakeComputerGateway();
      const controller = new AbortController();
      gateway.afterCall = () => controller.abort();
      const result = await inSlack(() =>
        invoke(
          toolsByName(gateway).get(item.name)!,
          item.input,
          channelContext(new FileAdapter(), controller.signal),
        ),
      );
      item.assert(result);
    }
  });

  test("reports signal-aware mutator success truthfully when abort races its return", async () => {
    const gateway = new FakeComputerGateway();
    const controller = new AbortController();
    gateway.afterCall = () => controller.abort();

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_click")!,
        { ref: "e4", snapshotId: 9 },
        channelContext(new FileAdapter(), controller.signal),
      ),
    );

    expect(result).toMatchObject({ ok: true, action: "click", ref: "e4" });
    expect(gateway.clickCalls).toHaveLength(1);
  });

  test("serializes an unexpected non-plain gateway value without silently collapsing it", async () => {
    const gateway = Object.assign(new FakeComputerGateway(), {
      async read() {
        return new Map([["status", "ready"]]);
      },
    });

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_read")!,
        {},
        channelContext(new FileAdapter()),
      ),
    );

    expect(result).toEqual({ ok: true, result: [["status", "ready"]] });
    expect(JSON.stringify(result)).toBe(
      '{"ok":true,"result":[["status","ready"]]}',
    );
  });

  test("fails safely for unsupported non-plain gateway values, including nested ones", async () => {
    for (const value of [/private-state/u, [/private-state/u]]) {
      const gateway = Object.assign(new FakeComputerGateway(), {
        async read() {
          return value;
        },
      });

      const result = await inSlack(() =>
        invoke(
          toolsByName(gateway).get("computer_read")!,
          {},
          channelContext(new FileAdapter()),
        ),
      );

      expect(result).toEqual(ACTION_FAILED);
      expect(JSON.stringify(result)).not.toContain("private-state");
    }
  });

  test("shares complete UTF-8 text with an explicit filename and reports adapter success", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    const signal = new AbortController().signal;
    const tool = toolsByName(gateway).get("computer_share_file")!;

    const result = await inSlack(() =>
      invoke(
        tool,
        { path: "reports/risk.txt", filename: "review.txt" },
        channelContext(adapter, signal),
      ),
    );

    expect(gateway.readFileCalls).toEqual([
      ["risk", { id: "u1", userId: "u1" }, { path: "reports/risk.txt" }],
    ]);
    expect(adapter.uploads).toHaveLength(1);
    expect(adapter.uploads[0]?.filename).toBe("review.txt");
    expect(new TextDecoder().decode(adapter.uploads[0]?.bytes)).toBe(
      "Résumé 📊",
    );
    expect(result).toEqual({
      ok: true,
      shared: true,
      filename: "review.txt",
      fileId: "slack-file-1",
    });
  });

  test("captures the current page and shares its PNG in the Slack thread", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_screenshot")!,
        { filename: "copilotkit-homepage.png" },
        channelContext(adapter),
      ),
    );

    expect(gateway.screenshotCalls).toEqual([["risk"]]);
    expect(adapter.uploads).toHaveLength(1);
    expect(adapter.uploads[0]?.filename).toBe("copilotkit-homepage.png");
    expect([...adapter.uploads[0]!.bytes]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(result).toEqual({
      ok: true,
      shared: true,
      filename: "copilotkit-homepage.png",
      fileId: "slack-file-1",
      width: 1440,
      height: 900,
      url: "https://copilotkit.ai/",
    });
  });

  test("opens, reads, and shares a website screenshot in one tool round", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();

    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_open_and_share_screenshot")!,
        {
          url: "https://copilotkit.ai",
          filename: "copilotkit-homepage.png",
        },
        channelContext(adapter),
      ),
    );

    expect(gateway.navigateCalls).toEqual([
      ["risk", { id: "u1", userId: "u1" }, "https://copilotkit.ai"],
    ]);
    expect(gateway.screenshotCalls).toEqual([["risk"]]);
    expect(adapter.effects).toEqual(["message", "file"]);
    expect(JSON.stringify(adapter.posted)).toContain("Summary: Page text");
    expect(JSON.stringify(adapter.posted)).toContain(
      "Source: https://copilotkit.ai",
    );
    expect(adapter.uploads).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      url: "https://copilotkit.ai",
      title: "Example",
      text: "Page text",
      truncated: false,
      elapsedMs: 4,
      summaryShared: true,
      screenshotShared: true,
      screenshotFilename: "copilotkit-homepage.png",
      screenshotWidth: 1440,
      screenshotHeight: 900,
      fileId: "slack-file-1",
    });
  });

  test("uses only a safe basename when the shared filename is omitted", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "private/reports/risk.txt" },
        channelContext(adapter),
      ),
    );
    expect(adapter.uploads[0]?.filename).toBe("risk.txt");
    expect(JSON.stringify(result)).not.toContain("private/reports");
  });

  test("refuses truncated reads and never posts incomplete file content", async () => {
    const gateway = new FakeComputerGateway();
    gateway.readFileResult = {
      path: "reports/huge.txt",
      text: "incomplete private content",
      truncated: true,
      bytes: 99_000_000,
    };
    const adapter = new FileAdapter();
    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/huge.txt" },
        channelContext(adapter),
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "That file is too large to read completely, so it was not shared.",
    });
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(adapter.uploads).toHaveLength(0);
  });

  test("returns an adapter size or type rejection exactly and never claims success", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    adapter.result = {
      ok: false,
      error: "Slack rejected this file type or size.",
    };
    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/risk.txt" },
        channelContext(adapter),
      ),
    );
    expect(result).toEqual({
      ok: false,
      reason: "Slack rejected this file type or size.",
    });
    expect(result).not.toHaveProperty("shared");
    expect(JSON.stringify(result)).not.toContain("Résumé");
  });

  test("honors abort checkpoints before upload without unsupported arguments", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    const stoppedAfterRead = new AbortController();
    gateway.afterCall = () => stoppedAfterRead.abort();
    const afterRead = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/risk.txt" },
        channelContext(adapter, stoppedAfterRead.signal),
      ),
    );
    expect(afterRead).toEqual(STOPPED);
    expect(gateway.readFileCalls[0]).toHaveLength(3);
    expect(adapter.uploads).toHaveLength(0);

    gateway.afterCall = undefined;
    const stoppedAfterUpload = new AbortController();
    adapter.afterUpload = () => stoppedAfterUpload.abort();
    const afterUpload = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/risk.txt" },
        channelContext(adapter, stoppedAfterUpload.signal),
      ),
    );
    expect(afterUpload).toEqual({
      ok: true,
      shared: true,
      filename: "risk.txt",
      fileId: "slack-file-1",
    });
    expect(adapter.uploads).toHaveLength(1);
  });

  test("revalidates a filename after removing Unicode control and format characters", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/risk.txt", filename: `.\u0000\u202e.` },
        channelContext(adapter),
      ),
    );
    expect(adapter.uploads[0]?.filename).toBe("file.txt");
    expect(result).toMatchObject({
      ok: true,
      shared: true,
      filename: "file.txt",
    });
  });

  test("removes Unicode line separators from shared filenames", async () => {
    const gateway = new FakeComputerGateway();
    const adapter = new FileAdapter();
    const result = await inSlack(() =>
      invoke(
        toolsByName(gateway).get("computer_share_file")!,
        { path: "reports/risk.txt", filename: "report\u2028private\u2029.txt" },
        channelContext(adapter),
      ),
    );
    expect(adapter.uploads[0]?.filename).toBe("reportprivate.txt");
    expect(result).toMatchObject({ filename: "reportprivate.txt" });
  });

  test("limits shared filenames to 255 UTF-8 bytes without splitting code points", async () => {
    const cases = [
      {
        filename: `${"a".repeat(300)}.txt`,
        expectedSuffix: ".txt",
      },
      {
        filename: `${"📊".repeat(100)}.json`,
        expectedSuffix: ".json",
      },
    ];

    for (const item of cases) {
      const gateway = new FakeComputerGateway();
      const adapter = new FileAdapter();
      const result = await inSlack(() =>
        invoke(
          toolsByName(gateway).get("computer_share_file")!,
          { path: "reports/risk.txt", filename: item.filename },
          channelContext(adapter),
        ),
      );
      const filename = adapter.uploads[0]?.filename ?? "";
      expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(
        255,
      );
      expect(filename.endsWith(item.expectedSuffix)).toBe(true);
      expect(filename).not.toContain("�");
      expect(result).toMatchObject({ ok: true, shared: true, filename });
    }
  });

  test("ChannelTools use schemas that Channels can parse without compatibility casts", async () => {
    const echo = defineChannelTool({
      ...toolsByName(new FakeComputerGateway()).get("computer_click")!,
      handler: ({ ref, snapshotId }) => ({ ref, snapshotId }),
    });
    const parsed = await parseToolArgs(echo.parameters, {
      ref: "e8",
      snapshotId: 3,
    });
    expect(parsed).toEqual({
      ok: true,
      value: { ref: "e8", snapshotId: 3 },
    });
  });
});
