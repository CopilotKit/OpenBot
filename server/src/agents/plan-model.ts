import { createHash } from "node:crypto";
import {
  EventSchemas,
  HttpAgent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import type { Subscription } from "rxjs";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../desktop-connection-failure";

// Use the model contract of the runtime we actually ship, without a second AI SDK version.
export type PlanLanguageModel = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type Options = Parameters<PlanLanguageModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type GenerateResult = Awaited<ReturnType<PlanLanguageModel["doGenerate"]>>;

export type PlanModelConfig = {
  provider: "chatgpt" | "claude";
  /** Resolved from the deployment's installed harness, never an agent registration. */
  endpoint: URL;
  token: string;
};
export const PLAN_RUN_COMPLETED = Symbol("plan-run-completed");

/** A plan is an explicit desktop credential choice, not an API-key fallback. */
export function planModelForEnvironment(
  environment: Record<string, string | undefined>,
): PlanModelConfig | undefined {
  const claude = !!environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const chatgpt = !!environment.CHATGPT_AUTH_FILE?.trim();
  if (!claude && !chatgpt) return undefined;
  if (claude && chatgpt)
    throw new Error("Choose one model plan for built-in Bots.");
  const image = environment.PICKED_HARNESS_IMAGE?.trim() ?? "";
  const harness = claude ? "agent-claude-sdk" : "agent-langgraph-agui";
  if (
    environment.PICKED_HARNESS_SOURCE?.trim() === "byo" ||
    !new RegExp(`(?:^|/)(?:openbot-)?${harness}(?::|@|$)`).test(image)
  ) {
    throw new Error(
      `The selected plan requires the installed ${harness} harness for built-in Bots.`,
    );
  }
  const address = environment.PICKED_HARNESS_URL?.trim();
  const token = environment.MANAGED_AGENT_TOKEN?.trim();
  if (!address || !token)
    throw new Error(
      "The selected plan's owned harness endpoint and token are missing.",
    );
  const endpoint = new URL(address);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "The selected plan's harness must have an HTTP endpoint without URL credentials.",
    );
  }
  if (claude)
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/model`;
  return { provider: claude ? "claude" : "chatgpt", endpoint, token };
}

const UNKNOWN_USAGE: GenerateResult["usage"] = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export function planMessages(prompt: Options["prompt"]): Message[] {
  const messages: Message[] = [];
  for (const [index, message] of prompt.entries()) {
    const id = `prompt-${index}`;
    if (message.role === "system") {
      messages.push({ id, role: "system", content: message.content });
    } else if (message.role === "user") {
      messages.push({
        id,
        role: "user",
        content: message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (!part.mediaType.startsWith("image/"))
            throw new Error(
              `Plan models cannot receive ${part.mediaType} attachments.`,
            );
          const data = part.data;
          const url =
            data instanceof URL
              ? data.href
              : `data:${part.mediaType};base64,${typeof data === "string" ? data : Buffer.from(data).toString("base64")}`;
          return { type: "binary", mimeType: part.mediaType, url };
        }),
      });
    } else if (message.role === "assistant") {
      const toolCalls = message.content.flatMap((part) =>
        part.type === "tool-call"
          ? [
              {
                id: part.toolCallId,
                type: "function" as const,
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
              },
            ]
          : [],
      );
      messages.push({
        id,
        role: "assistant",
        content: message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join(""),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else {
      for (const part of message.content) {
        if (part.type !== "tool-result")
          throw new Error(
            "Plan models do not execute provider approval requests.",
          );
        const output = part.output;
        const content =
          output.type === "execution-denied"
            ? `Tool execution denied: ${output.reason ?? "not approved"}`
            : typeof output.value === "string"
              ? output.value
              : JSON.stringify(output.value);
        messages.push({
          id: `result-${part.toolCallId}`,
          role: "tool",
          toolCallId: part.toolCallId,
          content,
        });
      }
    }
  }
  return messages;
}

/** The pinned JS client uses binary parts; current Python AG-UI uses image/source. */
function planWireBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  const input = JSON.parse(body) as RunAgentInput;
  return JSON.stringify({
    ...input,
    messages: input.messages.map((message) => {
      if (message.role !== "user" || typeof message.content === "string")
        return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "binary") return part;
          if (!part.mimeType.startsWith("image/"))
            throw new Error("The plan model only supports image media parts.");
          const encoded = part.data ?? part.url?.split(";base64,", 2)[1];
          return {
            type: "image",
            source:
              encoded !== undefined
                ? { type: "data", value: encoded, mimeType: part.mimeType }
                : { type: "url", value: part.url, mimeType: part.mimeType },
          };
        }),
      };
    }),
  });
}

/** Model transport only. BuiltInAgent still validates and executes every server tool. */
export class PlanModel implements PlanLanguageModel {
  readonly specificationVersion = "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};
  private readonly threadId: string;
  private pendingTools: string[] = [];
  private streaming = false;

  constructor(
    private readonly config: PlanModelConfig,
    private readonly botId: string,
    input: Pick<RunAgentInput, "threadId">,
    frontendTools: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ) {
    this.provider = `openbot-${config.provider}-plan`;
    this.modelId = config.provider;
    // Separate SDK/checkpoint state for two Bots in the same channel, stable across tool continuations.
    this.threadId = createHash("sha256")
      .update(JSON.stringify([botId, input.threadId]))
      .digest("hex");
    signal?.addEventListener(
      "abort",
      async () => {
        if (
          config.provider !== "claude" ||
          (!this.streaming && this.pendingTools.length === 0)
        )
          return;
        // A normal frontend-tool boundary must keep the SDK query for the next HTTP
        // continuation. Stop, a cancelled server tool, and the step limit must not.
        if (
          signal.reason === PLAN_RUN_COMPLETED &&
          this.pendingTools.some((name) => frontendTools.has(name))
        )
          return;
        try {
          const response = await fetch(
            `${config.endpoint.href.replace(/\/$/, "")}/cancel`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(5000),
              headers: {
                "content-type": "application/json",
                "x-openbot-agent-token": config.token,
              },
              body: JSON.stringify({ threadId: this.threadId }),
            },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch {
          // No request details: the URL and token belong to the deployment. The
          // harness's finite query timeout remains its final cleanup boundary.
          console.error("The owned Claude model query could not be cancelled.");
        }
      },
      { once: true },
    );
  }

  async doGenerate(options: Options): Promise<GenerateResult> {
    const { stream } = await this.doStream(options);
    const content: GenerateResult["content"] = [];
    const texts = new Map<string, { type: "text"; text: string }>();
    let finish: Extract<Part, { type: "finish" }> | undefined;
    for await (const part of stream) {
      if (part.type === "text-start") {
        const text = { type: "text" as const, text: "" };
        texts.set(part.id, text);
        content.push(text);
      }
      if (part.type === "text-delta") {
        const text = texts.get(part.id);
        if (text) text.text += part.delta;
      }
      if (part.type === "tool-call") content.push(part);
      if (part.type === "finish") finish = part;
      if (part.type === "error") throw part.error;
    }
    if (!finish) throw new Error("The plan model ended without a result.");
    return {
      content,
      finishReason: finish.finishReason,
      usage: finish.usage,
      warnings: [],
    };
  }

  async doStream(options: Options): Promise<StreamResult> {
    this.streaming = true;
    this.pendingTools = [];
    const messages = planMessages(options.prompt);
    const tools = (options.tools ?? []).map((tool) => {
      if (tool.type !== "function")
        throw new Error(
          "Built-in plan Bots only support caller-owned function tools.",
        );
      return {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      };
    });
    const names = new Set(tools.map((tool) => tool.name));
    const agent = new HttpAgent({
      url: this.config.endpoint.href,
      headers: { "x-openbot-agent-token": this.config.token },
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          body: planWireBody(init?.body),
          redirect: "error",
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            ...(options.abortSignal ? [options.abortSignal] : []),
          ]),
        }),
    });
    let subscription: Subscription | undefined;
    const stream = new ReadableStream<Part>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] });
        const calls = new Map<
          string,
          { name: string; args: string; ended: boolean }
        >();
        let terminal = false;
        const fail = (error: unknown) => {
          if (!terminal) {
            terminal = true;
            controller.error(error);
            subscription?.unsubscribe();
          }
        };
        subscription = agent
          .run({
            threadId:
              this.config.provider === "claude"
                ? this.threadId
                : `${this.threadId}-${crypto.randomUUID()}`,
            runId: crypto.randomUUID(),
            messages: messages.filter((message) => message.role !== "system"),
            tools,
            context: messages
              .filter((message) => message.role === "system")
              .map((message) => ({
                description: "Built-in Bot instructions",
                value: message.content ?? "",
              })),
            state: null,
            forwardedProps: {
              openbotModelOnly: true,
              openbotBotId: this.botId,
            },
          })
          .subscribe({
            next: (rawEvent) => {
              if (terminal) return;
              try {
                // Python snapshots can carry newer media parts than this JS client.
                // The model consumes text/tool deltas, never remote conversation state.
                if (
                  ![
                    "TEXT_MESSAGE_START",
                    "TEXT_MESSAGE_CONTENT",
                    "TEXT_MESSAGE_END",
                    "TOOL_CALL_START",
                    "TOOL_CALL_ARGS",
                    "TOOL_CALL_END",
                    "RUN_ERROR",
                    "RUN_FINISHED",
                  ].includes(rawEvent.type)
                )
                  return;
                const event = EventSchemas.parse(rawEvent);
                switch (event.type) {
                  case "TEXT_MESSAGE_START":
                    controller.enqueue({
                      type: "text-start",
                      id: event.messageId,
                    });
                    break;
                  case "TEXT_MESSAGE_CONTENT":
                    controller.enqueue({
                      type: "text-delta",
                      id: event.messageId,
                      delta: event.delta,
                    });
                    break;
                  case "TEXT_MESSAGE_END":
                    controller.enqueue({
                      type: "text-end",
                      id: event.messageId,
                    });
                    break;
                  case "TOOL_CALL_START":
                    if (!names.has(event.toolCallName))
                      throw new Error(
                        `The plan harness attempted an unoffered tool: ${event.toolCallName}`,
                      );
                    calls.set(event.toolCallId, {
                      name: event.toolCallName,
                      args: "",
                      ended: false,
                    });
                    controller.enqueue({
                      type: "tool-input-start",
                      id: event.toolCallId,
                      toolName: event.toolCallName,
                    });
                    break;
                  case "TOOL_CALL_ARGS": {
                    const call = calls.get(event.toolCallId);
                    if (!call || call.ended)
                      throw new Error("Unexpected plan tool arguments.");
                    call.args += event.delta;
                    controller.enqueue({
                      type: "tool-input-delta",
                      id: event.toolCallId,
                      delta: event.delta,
                    });
                    break;
                  }
                  case "TOOL_CALL_END": {
                    const call = calls.get(event.toolCallId);
                    if (!call || call.ended)
                      throw new Error("Unexpected plan tool completion.");
                    call.ended = true;
                    controller.enqueue({
                      type: "tool-input-end",
                      id: event.toolCallId,
                    });
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: event.toolCallId,
                      toolName: call.name,
                      input: call.args,
                    });
                    break;
                  }
                  case "RUN_ERROR": {
                    const error = new Error(event.message);
                    if (event.code === "OPENBOT_MODEL_AUTH_REQUIRED") {
                      error.name = "OpenBotModelAuthenticationError";
                      recordDesktopConnectionFailure({
                        connection: "model",
                        code: "provider_authentication_failed",
                      });
                    }
                    throw error;
                  }
                  case "RUN_FINISHED":
                    if ([...calls.values()].some((call) => !call.ended))
                      throw new Error(
                        "The plan harness ended during a tool call.",
                      );
                    terminal = true;
                    this.streaming = false;
                    this.pendingTools = [...calls.values()].map(
                      (call) => call.name,
                    );
                    clearDesktopConnectionFailure("model");
                    controller.enqueue({
                      type: "finish",
                      finishReason: {
                        unified: calls.size ? "tool-calls" : "stop",
                        raw: undefined,
                      },
                      usage: UNKNOWN_USAGE,
                    });
                    controller.close();
                    break;
                }
              } catch (error) {
                fail(error);
              }
            },
            error: fail,
            complete: () => {
              if (!terminal)
                fail(
                  new Error(
                    "The plan harness disconnected before completing its response.",
                  ),
                );
            },
          });
      },
      cancel: () => {
        subscription?.unsubscribe();
        agent.abortRun();
      },
    });
    return { stream };
  }
}
