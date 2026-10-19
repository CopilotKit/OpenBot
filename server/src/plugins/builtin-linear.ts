import {
  assignLinearIssue,
  createLinearIssue,
  fetchLinearIssueByIdentifier,
  fetchLinearViewer,
  formatIssueSummary,
  listLinearIssues,
} from "../linear/client";
import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

export type LinearToolsConfig = {
  apiKey: string;
  defaultTeamId?: string;
};

let installed: LinearToolsConfig | null = null;

export function useLinearTools(config: LinearToolsConfig | null): void {
  installed = config;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "get_linear_viewer",
    description:
      "Read which Linear user this deployment's API key represents (name and email). Use before assigning issues to yourself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_linear_issue",
    description:
      "Read one Linear issue by identifier (for example ORC-424): title, status, assignee, and URL.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Linear identifier such as ORC-424.",
        },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "list_linear_issues",
    description:
      "List Linear issues, optionally filtered by assignee email or name. Use for questions like what is assigned to someone.",
    inputSchema: {
      type: "object",
      properties: {
        assigneeEmail: {
          type: "string",
          description:
            "Filter to issues assigned to this Linear account email.",
        },
        assigneeNameContains: {
          type: "string",
          description:
            "Filter to issues whose assignee name contains this text (case insensitive).",
        },
        limit: {
          type: "number",
          description: "Maximum issues to return (1–100, default 30).",
        },
      },
    },
  },
  {
    name: "create_linear_issue",
    description:
      "Create a Linear issue in a team. Requires teamId unless LINEAR_TEAM_ID is configured on the server.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title." },
        description: {
          type: "string",
          description: "Issue description (markdown).",
        },
        teamId: {
          type: "string",
          description: "Linear team UUID. Omit when the server default is set.",
        },
        assignToMe: {
          type: "boolean",
          description:
            "When true, assign the new issue to the Linear user for this API key.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "assign_linear_issue_to_me",
    description:
      "Assign an existing Linear issue to the user represented by this deployment's Linear API key.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Linear identifier such as ORC-424.",
        },
      },
      required: ["ticketId"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

function notConfigured(): McpCallResult {
  return {
    text: "Linear is not configured on this server. Set LINEAR_API_KEY (and LINEAR_TEAM_ID for creates).",
    isError: true,
    truncated: false,
  };
}

function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated]`,
    isError: false,
    truncated: true,
  };
}

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!installed) return notConfigured();

  try {
    switch (toolName) {
      case "get_linear_viewer": {
        const viewer = await fetchLinearViewer(installed.apiKey);
        return asResult(
          `Linear viewer: ${viewer.name} <${viewer.email}> (id ${viewer.id})`,
        );
      }
      case "get_linear_issue": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) {
          return {
            text: "ticketId is required, for example ORC-424.",
            isError: true,
            truncated: false,
          };
        }
        const issue = await fetchLinearIssueByIdentifier(
          installed.apiKey,
          ticketId,
        );
        return asResult(formatIssueSummary(issue));
      }
      case "list_linear_issues": {
        const issues = await listLinearIssues(installed.apiKey, {
          assigneeEmail: stringArg(args, "assigneeEmail"),
          assigneeNameContains: stringArg(args, "assigneeNameContains"),
          first: numberArg(args, "limit"),
        });
        if (issues.length === 0) {
          return asResult("No Linear issues matched that filter.");
        }
        return asResult(
          issues.map((issue) => formatIssueSummary(issue)).join("\n\n"),
        );
      }
      case "create_linear_issue": {
        const title = stringArg(args, "title");
        if (!title) {
          return {
            text: "title is required.",
            isError: true,
            truncated: false,
          };
        }
        const teamId =
          stringArg(args, "teamId") ?? installed.defaultTeamId ?? "";
        if (!teamId) {
          return {
            text: "teamId is required. Pass it in the tool call or set LINEAR_TEAM_ID on the server.",
            isError: true,
            truncated: false,
          };
        }
        let assigneeId: string | undefined;
        if (args.assignToMe === true) {
          assigneeId = (await fetchLinearViewer(installed.apiKey)).id;
        }
        const issue = await createLinearIssue(installed.apiKey, {
          teamId,
          title,
          description: stringArg(args, "description"),
          assigneeId,
        });
        return asResult(`Created ${formatIssueSummary(issue)}`);
      }
      case "assign_linear_issue_to_me": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) {
          return {
            text: "ticketId is required, for example ORC-424.",
            isError: true,
            truncated: false,
          };
        }
        const viewer = await fetchLinearViewer(installed.apiKey);
        const existing = await fetchLinearIssueByIdentifier(
          installed.apiKey,
          ticketId,
        );
        const updated = await assignLinearIssue(
          installed.apiKey,
          existing.id,
          viewer.id,
        );
        return asResult(`Assigned to you:\n${formatIssueSummary(updated)}`);
      }
      default:
        return {
          text: `${toolName} is not a Linear tool.`,
          isError: true,
          truncated: false,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: message, isError: true, truncated: false };
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}
