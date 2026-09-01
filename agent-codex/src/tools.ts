import type { RunAgentInput } from "@ag-ui/core";
import { createHash } from "node:crypto";

export type CodexDynamicTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = {
  text: string;
  success: boolean;
};

type ToolGatewayOptions = {
  url: string;
  token: string;
  fetch?: typeof fetch;
};

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_PARAMETERS = { type: "object", properties: {} };

/**
 * Only tools OpenBot says this deployment executes become Codex dynamic tools.
 *
 * AG-UI's `tools` array also contains browser-owned components and human-input tools. Routing those
 * to the deployment gateway would turn a chart into a failed MCP call, so the signed run metadata's
 * deployment-owned allowlist is the authority for which descriptions cross this boundary.
 */
export function dynamicToolsOf(input: RunAgentInput): CodexDynamicTool[] {
  const deploymentTools = deploymentToolNames(input);
  const seen = new Set<string>();
  const tools: CodexDynamicTool[] = [];

  for (const tool of input.tools ?? []) {
    if (!deploymentTools.has(tool.name) || seen.has(tool.name)) continue;
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(
        `OpenBot tool ${tool.name} cannot be exposed to Codex because its name is not Responses-API safe.`,
      );
    }
    seen.add(tool.name);
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description || "An OpenBot-governed tool.",
      inputSchema: isObject(tool.parameters)
        ? tool.parameters
        : DEFAULT_PARAMETERS,
    });
  }

  return tools;
}

/** Identifies the exact dynamic-tool catalogue persisted in a Codex rollout. */
export function toolCatalogueFingerprint(tools: CodexDynamicTool[]): string {
  const canonical = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => canonicalJsonValue(tool));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

export function runAssertionOf(input: RunAgentInput): string {
  const props = input.forwardedProps as { openbotRun?: unknown } | undefined;
  return typeof props?.openbotRun === "string" ? props.openbotRun : "";
}

function deploymentToolNames(input: RunAgentInput): Set<string> {
  const props = input.forwardedProps as
    | { openbotDeploymentTools?: unknown }
    | undefined;
  const names = props?.openbotDeploymentTools;
  return new Set(
    Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string")
      : [],
  );
}

/** Calls an OpenBot tool through the deployment that owns its grant, policy and audit row. */
export class OpenBotToolGateway {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ToolGatewayOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async call(
    run: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!this.options.token) {
      return {
        text: "Refused. This Codex coworker has no credential for OpenBot's tool gateway.",
        success: false,
      };
    }
    if (!run) {
      return {
        text: "Refused. This run carried no signed statement of which Bot and person it is for.",
        success: false,
      };
    }

    try {
      const response = await this.fetch(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": this.options.token,
        },
        body: JSON.stringify({ name, args, run }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(65_000)])
          : AbortSignal.timeout(65_000),
      });
      const body = (await response.json().catch(() => null)) as {
        text?: unknown;
        isError?: unknown;
        error?: unknown;
      } | null;

      if (!response.ok) {
        const reason =
          typeof body?.error === "string"
            ? body.error
            : `OpenBot's tool gateway returned HTTP ${response.status}.`;
        return { text: `Refused. ${reason}`, success: false };
      }

      const text =
        typeof body?.text === "string"
          ? body.text
          : "The OpenBot tool returned nothing.";
      return { text, success: body?.isError !== true };
    } catch (error) {
      return {
        text: `That tool could not be called through OpenBot: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        success: false,
      };
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  );
}
