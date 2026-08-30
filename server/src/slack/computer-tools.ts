import {
  type ChannelTool,
  type ChannelToolContext,
  defineChannelTool,
} from "@copilotkit/channels";
import {
  computerClickContract,
  computerKeyContract,
  computerListFilesContract,
  computerNavigateContract,
  computerOpenAndShareScreenshotContract,
  computerReadContract,
  computerReadFileContract,
  computerRequestHelpContract,
  computerRequestSecretContract,
  computerRunCommandContract,
  computerScreenshotContract,
  computerScrollContract,
  computerShareFileContract,
  computerSnapshotContract,
  computerTypeContract,
  computerWriteFileContract,
} from "../../../shared/computer-tool-contracts";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../computer/gateway";
import {
  requestSlackHelp,
  requestSlackSecret,
  type SlackAssistanceOptions,
} from "./assistance";
import {
  maybeCurrentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "./execution-context";

const COMPUTER_UNAVAILABLE =
  "The assistant's computer could not be reached." as const;
const COMPUTER_CONTEXT_UNAVAILABLE =
  "The computer action could not start because its Slack context was unavailable." as const;
const COMPUTER_ACTION_FAILED = "The computer action failed." as const;

class SlackComputerContextError extends Error {
  constructor() {
    super("The Slack computer tool is missing its private execution context.");
    this.name = "SlackComputerContextError";
  }
}

type ToolOutcome = Record<string, unknown> & { ok: boolean };

/** The public common type consumed by Channels when registering this heterogeneous tool list. */
export type SlackComputerTool = ChannelTool;

type SlackExecutionForConversation = (
  conversationKey: string,
) => SlackExecution | undefined;

function stopped(): ToolOutcome {
  return { ok: false, stopped: true, reason: "Stopped." };
}

function throwIfStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

function success(result: unknown): ToolOutcome {
  const serializable = serializableValue(result);
  if (isPlainRecord(serializable)) {
    const record = serializable;
    // A compound operation such as file sharing may already have a truthful explicit outcome.
    if (typeof record.ok === "boolean") return record as ToolOutcome;
    return { ...record, ok: true };
  }
  return { ok: true, result: serializable };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializableValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") {
    throw new TypeError("ComputerGateway returned a non-serializable result.");
  }
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) {
    throw new TypeError("ComputerGateway returned a circular result.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => serializableValue(item, ancestors));
    }
    if (value instanceof Map) {
      return [...value.entries()].map(([key, item]) => [
        serializableValue(key, ancestors),
        serializableValue(item, ancestors),
      ]);
    }
    if (value instanceof Set) {
      return [...value.values()].map((item) =>
        serializableValue(item, ancestors),
      );
    }
    if (isPlainRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          serializableValue(item, ancestors),
        ]),
      );
    }
  } finally {
    ancestors.delete(value);
  }
  throw new TypeError("ComputerGateway returned a non-serializable result.");
}

/**
 * Normalize only the control-plane failures whose meaning is safe for an agent to act on.
 * Everything else is deliberately opaque: transport details, paths, and secrets never cross into
 * the Slack transcript or model result.
 */
async function governed(
  signal: AbortSignal | undefined,
  run: () => Promise<unknown>,
  options: { checkStoppedAfter?: boolean } = {},
): Promise<ToolOutcome> {
  try {
    throwIfStopped(signal);
    const result = await run();
    // Some gateway methods predate caller-signal plumbing. This checkpoint prevents their result
    // from being reported or used after Stop, even though work already in flight cannot be cancelled.
    if (options.checkStoppedAfter !== false) throwIfStopped(signal);
    return success(result);
  } catch (error) {
    // The computer transport deliberately wraps fetch aborts as unavailable. The caller signal is
    // the typed evidence that this particular unavailable response means Stop, not an outage.
    if (signal?.aborted || isAbortError(error)) return stopped();
    if (error instanceof ActionRefusedError) {
      return {
        ok: false,
        refused: true,
        reason: error.message,
        rule: error.rule,
      };
    }
    if (
      error instanceof NavigationRefusedError ||
      error instanceof WorkspaceRefusedError
    ) {
      return { ok: false, refused: true, reason: error.message };
    }
    if (error instanceof WorkspaceRequestError) {
      return { ok: false, reason: error.message };
    }
    if (
      error instanceof StaleSnapshotError ||
      error instanceof ElementNotFoundError
    ) {
      return { ok: false, staleRefs: true, reason: error.message };
    }
    if (error instanceof HumanHasControlError) {
      return { ok: false, humanHasControl: true, reason: error.message };
    }
    if (error instanceof ComputerUnavailableError) {
      return { ok: false, reason: COMPUTER_UNAVAILABLE };
    }
    // Do not serialize the error: gateway and configuration failures can contain transport details,
    // paths, or secrets. The category is enough to distinguish a lost Slack turn from a real host
    // outage while preserving an opaque tool result.
    const contextUnavailable = error instanceof SlackComputerContextError;
    const errorCategory = contextUnavailable ? "execution-context" : "unknown";
    console.error(
      JSON.stringify({
        type: "slack-computer-tool-failed",
        error: contextUnavailable
          ? "SlackComputerContextError"
          : "UnknownError",
        context: {
          integration: "slack",
          operation: "computer-tool",
          errorCategory,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return {
      ok: false,
      reason: contextUnavailable
        ? COMPUTER_CONTEXT_UNAVAILABLE
        : COMPUTER_ACTION_FAILED,
    };
  }
}

function currentComputer(): { agentId: string; actor: ActionActor } {
  const execution = maybeCurrentSlackExecution();
  if (!execution?.agentId) {
    throw new SlackComputerContextError();
  }
  return {
    agentId: execution.agentId,
    // This is the linked OpenBot principal from private ALS. The provider actor in Channel context is
    // deliberately not authorization identity and never reaches ComputerGateway.
    actor: { id: execution.actor.id, userId: execution.actor.id },
  };
}

function bindSlackExecution(
  tool: SlackComputerTool,
  executionForConversation?: SlackExecutionForConversation,
): SlackComputerTool {
  return {
    ...tool,
    handler: (input, context) => {
      const run = () => tool.handler(input, context);
      if (maybeCurrentSlackExecution()) return run();
      const conversationKey =
        "conversationKey" in context.thread &&
        typeof context.thread.conversationKey === "string"
          ? context.thread.conversationKey
          : undefined;
      const execution = conversationKey
        ? executionForConversation?.(conversationKey)
        : undefined;
      return execution ? runWithSlackExecution(execution, run) : run();
    },
  };
}

function safeFilename(pathOrName: string): string {
  const basename = pathOrName.split(/[\\/]/).pop()?.trim();
  if (!basename || basename === "." || basename === "..") return "file.txt";
  // Slack filenames cannot safely carry controls. Removing them does not expose the workspace path.
  const clean = [...basename]
    .filter((character) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character))
    .join("")
    .trim();
  if (!clean || clean === "." || clean === "..") return "file.txt";
  return limitUtf8Filename(clean, 255);
}

function limitUtf8Filename(filename: string, maxBytes: number): string {
  if (utf8Bytes(filename) <= maxBytes) return filename;

  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot) : "";
  const extensionBytes = utf8Bytes(extension);
  if (extension && extensionBytes < maxBytes) {
    const stem = takeUtf8Bytes(
      filename.slice(0, dot),
      maxBytes - extensionBytes,
    );
    if (stem) return `${stem}${extension}`;
  }
  return takeUtf8Bytes(filename, maxBytes) || "file.txt";
}

function takeUtf8Bytes(value: string, maxBytes: number): string {
  let used = 0;
  let result = "";
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Computer tools for Slack turns.
 *
 * Every operation enters through ComputerGateway, preserving its policy decision and audit record.
 * Assistance operations are added only with a configured secure handoff; without one, exposing
 * them would falsely claim that a person in Slack had been reached.
 */
export function createSlackComputerTools(
  gateway: ComputerGateway,
  assistance?: SlackAssistanceOptions,
  executionForConversation?: SlackExecutionForConversation,
): SlackComputerTool[] {
  const tools: SlackComputerTool[] = [
    defineChannelTool({
      ...computerNavigateContract,
      description:
        computerNavigateContract.description +
        " In Slack, if the request also asks for a screenshot or picture, use " +
        "computer_open_and_share_screenshot instead.",
      handler: ({ url }, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.navigate(agentId, actor, url);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerOpenAndShareScreenshotContract,
      handler: (input, context) =>
        openAndShareScreenshot(gateway, input, context),
    }),
    defineChannelTool({
      ...computerScreenshotContract,
      handler: (input, context) => shareScreenshot(gateway, input, context),
    }),
    defineChannelTool({
      ...computerReadContract,
      handler: (_input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId } = currentComputer();
            return gateway.read(agentId);
          },
          { checkStoppedAfter: true },
        ),
    }),
    defineChannelTool({
      ...computerSnapshotContract,
      handler: (_input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId } = currentComputer();
            return gateway.snapshot(agentId);
          },
          { checkStoppedAfter: true },
        ),
    }),
    defineChannelTool({
      ...computerTypeContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.type(agentId, actor, input, signal);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerClickContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.click(agentId, actor, input, signal);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerKeyContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.key(agentId, actor, input, signal);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerListFilesContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.listFiles(agentId, actor, input);
          },
          { checkStoppedAfter: true },
        ),
    }),
    defineChannelTool({
      ...computerReadFileContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.readFile(agentId, actor, input);
          },
          { checkStoppedAfter: true },
        ),
    }),
    defineChannelTool({
      ...computerRunCommandContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.runCommand(agentId, actor, input, signal);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerWriteFileContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.writeFile(agentId, actor, input);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerScrollContract,
      handler: (input, { signal }) =>
        governed(
          signal,
          async () => {
            const { agentId, actor } = currentComputer();
            return gateway.scroll(agentId, actor, input);
          },
          { checkStoppedAfter: false },
        ),
    }),
    defineChannelTool({
      ...computerShareFileContract,
      handler: (input, context) => shareFile(gateway, input, context),
    }),
  ];
  if (assistance) {
    tools.push(
      defineChannelTool({
        ...computerRequestHelpContract,
        handler: ({ reason }, context) =>
          governed(
            context.signal,
            () => requestSlackHelp(gateway, reason, context, assistance),
            { checkStoppedAfter: false },
          ),
      }),
      defineChannelTool({
        ...computerRequestSecretContract,
        handler: (input, context) =>
          governed(
            context.signal,
            () => requestSlackSecret(gateway, input, context, assistance),
            { checkStoppedAfter: false },
          ),
      }),
    );
  }
  return tools.map((tool) =>
    bindSlackExecution(tool, executionForConversation),
  );
}

async function openAndShareScreenshot(
  gateway: ComputerGateway,
  input: { url: string; filename?: string },
  context: ChannelToolContext,
): Promise<ToolOutcome> {
  return governed(
    context.signal,
    async () => {
      const { agentId, actor } = currentComputer();
      const navigation = await gateway.navigate(agentId, actor, input.url);
      throwIfStopped(context.signal);
      const screenshot = await gateway.screenshot(agentId);
      throwIfStopped(context.signal);

      const filename = safeFilename(input.filename ?? "screenshot.png");
      // Intelligence currently accepts a Slack file effect but can reject a later text stream in
      // the same managed delivery. Put the useful page text first so the person receives both the
      // answer and the image even when that provider ordering limitation is present.
      await context.thread.post(pageSummaryMessage(navigation));
      throwIfStopped(context.signal);
      const posted = await context.thread.postFile({
        bytes: Buffer.from(screenshot.base64, "base64"),
        filename,
      });
      if (!posted.ok) {
        return {
          ok: false,
          reason: posted.error ?? "Slack could not share that screenshot.",
        };
      }
      return {
        ok: true,
        ...navigation,
        summaryShared: true,
        screenshotShared: true,
        screenshotFilename: filename,
        screenshotWidth: screenshot.width,
        screenshotHeight: screenshot.height,
        ...(posted.fileId ? { fileId: posted.fileId } : {}),
        ...(posted.assetId ? { assetId: posted.assetId } : {}),
      };
    },
    { checkStoppedAfter: false },
  );
}

function pageSummaryMessage(navigation: {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}): string {
  const readable = navigation.text.replace(/\s+/g, " ").trim();
  const excerpt = takeUtf8Bytes(readable, 1_200).trim();
  const summary =
    excerpt || navigation.title || "The page did not expose readable text.";
  return [
    `I opened ${navigation.title || navigation.url}.`,
    `Summary: ${summary}${navigation.truncated ? " (The page extract was truncated.)" : ""}`,
    `Source: ${navigation.url}, read just now.`,
  ].join("\n\n");
}

async function shareScreenshot(
  gateway: ComputerGateway,
  input: { filename?: string },
  context: ChannelToolContext,
): Promise<ToolOutcome> {
  return governed(
    context.signal,
    async () => {
      const { agentId } = currentComputer();
      // screenshot has no signal parameter today. Check both sides so Stop prevents the upload even
      // when it arrived while the capture was in flight.
      throwIfStopped(context.signal);
      const screenshot = await gateway.screenshot(agentId);
      throwIfStopped(context.signal);

      const filename = safeFilename(input.filename ?? "screenshot.png");
      const bytes = Buffer.from(screenshot.base64, "base64");
      throwIfStopped(context.signal);
      const posted = await context.thread.postFile({ bytes, filename });
      // Upload is the irreversible commit point. Once Slack answers, report that exact outcome even
      // if cancellation raced the response.
      if (!posted.ok) {
        return {
          ok: false,
          reason: posted.error ?? "Slack could not share that screenshot.",
        };
      }
      return {
        ok: true,
        shared: true,
        filename,
        width: screenshot.width,
        height: screenshot.height,
        ...(screenshot.url ? { url: screenshot.url } : {}),
        ...(posted.fileId ? { fileId: posted.fileId } : {}),
        ...(posted.assetId ? { assetId: posted.assetId } : {}),
      };
    },
    { checkStoppedAfter: false },
  );
}

async function shareFile(
  gateway: ComputerGateway,
  input: { path: string; filename?: string },
  context: ChannelToolContext,
): Promise<ToolOutcome> {
  return governed(
    context.signal,
    async () => {
      const { agentId, actor } = currentComputer();
      // readFile has no signal parameter today. Check both sides so Stop prevents the upload even
      // when it arrived while the governed read was in flight.
      throwIfStopped(context.signal);
      const file = await gateway.readFile(agentId, actor, { path: input.path });
      throwIfStopped(context.signal);
      if (file.truncated) {
        return {
          ok: false,
          reason:
            "That file is too large to read completely, so it was not shared.",
        };
      }

      const filename = safeFilename(input.filename ?? input.path);
      const bytes = new TextEncoder().encode(file.text);
      throwIfStopped(context.signal);
      const posted = await context.thread.postFile({ bytes, filename });
      // Upload is the irreversible commit point. Once the adapter has answered, its explicit result
      // is more truthful than replacing a success with "Stopped" because cancellation raced it.
      if (!posted.ok) {
        return {
          ok: false,
          reason: posted.error ?? "Slack could not share that file.",
        };
      }
      return {
        ok: true,
        shared: true,
        filename,
        ...(posted.fileId ? { fileId: posted.fileId } : {}),
        ...(posted.assetId ? { assetId: posted.assetId } : {}),
      };
    },
    { checkStoppedAfter: false },
  );
}
