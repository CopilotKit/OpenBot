import { useFrontendTool } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import { markdownComponents } from "@/lib/markdown";
import * as z from "zod";
import { useActiveBotId } from "@/lib/copilot/active-bot";
import {
  agentPluginsQueryOptions,
  callPluginTool,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

/**
 * Runtime-discovered MCP tools granted to the active Bot. Registration controls what is offered;
 * the server still rechecks each call.
 */
export function PluginTools() {
  const botId = useActiveBotId();
  const { data } = useQuery(agentPluginsQueryOptions(botId));
  const granted: GrantedPlugins = data ?? { tools: [], skills: [] };

  /** Keep previously offered tools mounted so mid-run revocations can return explicit refusals. */
  const seen = useRef(new Map<string, GrantedPlugins["tools"][number]>());
  for (const tool of granted.tools) seen.current.set(tool.ref, tool);
  const offered = [...seen.current.values()];

  return (
    <>
      {offered.map((tool) => (
        <PluginTool
          botId={botId}
          description={tool.description}
          inputSchema={tool.inputSchema}
          key={tool.ref}
          name={tool.toolName}
          toolRef={tool.ref}
        />
      ))}
    </>
  );
}

/** Convert vendor JSON Schema to SDK parameters; unreadable schemas fall back to catchall. */
function parametersFor(inputSchema: Record<string, unknown>) {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    // Only object schemas describe tool arguments; other vendor schemas fall back to catchall.
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
function forDisplay(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent.
    return text;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      return `${body}\n\n\`\`\`json\n${JSON.stringify(
        Object.fromEntries(rest),
        null,
        2,
      )}\n\`\`\``;
    }
  }

  return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

function PluginTool({
  name,
  toolRef,
  description,
  inputSchema,
  botId,
}: {
  name: string;
  toolRef: string;
  description: string;
  inputSchema: Record<string, unknown>;
  botId: string;
}) {
  /**
   * Per-call render state. The SDK captures `render` at registration, so the renderer must read
   * current results from a ref keyed by tool call id.
   */
  const calls = useRef(
    new Map<
      string,
      {
        result?: { text: string; isError: boolean };
        outcome?: { refused: boolean; reason: string };
      }
    >(),
  );
  /** Bumped only to make React redraw; the data itself lives in the ref above. */
  const [, redraw] = useState(0);
  const touch = () => redraw((tick) => tick + 1);

  const [serverId, ...rest] = toolRef.split("/");
  const bareName = rest.join("/");

  useFrontendTool({
    name,
    // The vendor's own description, with the server named. A model choosing between two servers that
    // both offer "search" needs to know which is which, and vendors do not write their descriptions
    // expecting to sit beside another vendor's.
    description: description
      ? `${description} (${serverId})`
      : `${bareName} on ${serverId}.`,
    parameters: parametersFor(inputSchema),
    handler: async (
      args: Record<string, unknown>,
      // DEFAULTED, because the context argument is optional and a handler that destructures it
      // unconditionally throws on any call that omits it.
      context: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const id = context.toolCall?.id ?? "";
      const result = await callPluginTool(
        toolRef,
        args ?? {},
        botId,
        context.signal,
        // So a question the boundary raises about this call is drawn on this call's own line.
        id,
      );

      if (result.ok) {
        calls.current.set(id, {
          result: { text: result.text, isError: result.isError },
        });
        touch();
        // Return MCP text to the model; vendor errors stay as tool results instead of thrown errors.
        return result.isError
          ? `The tool reported an error: ${result.text}`
          : result.text;
      }

      calls.current.set(id, {
        outcome: { refused: result.refused, reason: result.reason },
      });
      touch();
      return result.reason;
    },
    render: ({ status, toolCallId }) => {
      const entry = calls.current.get(toolCallId ?? "") ?? {};
      const { result, outcome } = entry;

      // Render policy refusals separately from vendor/server failures.
      if (outcome) {
        return (
          <ToolLine
            detail={outcome.reason}
            failed={!outcome.refused}
            label={bareName}
            refused={outcome.refused}
          />
        );
      }

      return (
        <>
          {/*
           * A boundary can stop a tool call the same way it stops a click, so the question belongs
           * on this line rather than only on the lines about a browser.
           */}
          <ApprovalRequest toolCallId={toolCallId} />
          <ToolLine
            detail={serverId}
            failed={result?.isError}
            label={bareName}
            running={status !== "complete"}
          >
            {result ? (
              /* The server's own words, drawn the way a Bot's prose is drawn. */
              <Streamdown components={markdownComponents}>
                {forDisplay(result.text)}
              </Streamdown>
            ) : null}
          </ToolLine>
        </>
      );
    },
  });

  return null;
}
