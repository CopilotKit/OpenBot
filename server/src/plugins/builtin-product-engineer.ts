import type { ProductEngineerRunner } from "../product-engineer/runner";
import type {
  ProductEngineerRunRow,
  ProductEngineerStore,
} from "../product-engineer/store";
import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * In-process Product Engineer tools so any granted Bot can start, check, resume,
 * or certify a Cursor cloud coding run from chat.
 *
 * The HTTP page and these tools share one runner, installed from `createApp`,
 * so a chat start and a page start cannot spawn two cloud agents for one ticket.
 */

let installed: {
  runner: ProductEngineerRunner;
  store: ProductEngineerStore;
} | null = null;

export function useProductEngineerTools(
  tools: {
    runner: ProductEngineerRunner;
    store: ProductEngineerStore;
  } | null,
): void {
  installed = tools;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "start_product_engineer_run",
    description: [
      "Start a Product Engineer loop on a Linear ticket (for example ORC-424).",
      "This drafts an implementation plan and waits for human approval — it does not start Cursor coding yet.",
      "Tell them the ticket id, that a plan is awaiting approval on /product-engineer, and that coding starts only after they approve the plan.",
      "Use approve_product_engineer_plan when they explicitly approve the plan.",
      "Do not invent a pull request URL. Only report prUrl when a tool result includes one.",
      "Approve (post-PR certify) does not merge. Merge stays in GitHub.",
    ].join(" "),
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
    name: "list_product_engineer_runs",
    description:
      "List recent Product Engineer runs: ticket id, title, status, pull request URL, and last update. Use this when the person asks what is in progress.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_product_engineer_run",
    description:
      "Read one Product Engineer run, including status, plan text, progress, error, and pull request URL. Call this to answer 'how is ORC-424 going?' or to show the plan awaiting approval.",
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
    name: "sync_product_engineer_run",
    description:
      "Re-read Cursor cloud for a run that still says implementing or revising. Use this when the page looks stuck after a server restart. Then report the synced status and prUrl.",
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
    name: "approve_product_engineer_plan",
    description:
      "Approve the implementation plan for a run that is awaiting_plan_approval, so Cursor cloud coding can start. Only when the person explicitly approves the plan.",
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
    name: "reject_product_engineer_plan",
    description:
      "Reject or revise the plan for a run awaiting_plan_approval. Requires feedback describing what to change. Regenerates the plan and waits for approval again. Coding does not start.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Linear identifier such as ORC-424.",
        },
        feedback: {
          type: "string",
          description: "What to change in the plan.",
        },
      },
      required: ["ticketId", "feedback"],
    },
  },
  {
    name: "resume_product_engineer_run",
    description:
      "Send feedback to a run that is awaiting review, so the same Cursor agent revises the pull request. Only when the person has given the feedback.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Linear identifier such as ORC-424.",
        },
        feedback: {
          type: "string",
          description: "What the Product Engineer should change.",
        },
      },
      required: ["ticketId", "feedback"],
    },
  },
  {
    name: "approve_product_engineer_run",
    description:
      "Mark a run awaiting review as certified in AgentForce. Only when the person explicitly asks to approve or certify. This does not merge the pull request.",
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

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

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

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function describe(run: ProductEngineerRunRow): string {
  const lines = [
    `${run.ticketId} — ${run.title}`,
    `status: ${run.status}`,
    run.agentId
      ? `cursor agent: ${run.agentId}`
      : "cursor agent: not assigned yet",
    run.prUrl ? `pull request: ${run.prUrl}` : "pull request: none yet",
    `linear: ${run.linearUrl}`,
    `updated: ${run.updatedAt}`,
    "watch: /product-engineer",
  ];
  if (run.plan) lines.push(`plan:\n${run.plan}`);
  if (run.progress) lines.push(`progress:\n${run.progress}`);
  if (run.error) lines.push(`error:\n${run.error}`);
  return lines.join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const tools = installed;
  if (!tools) {
    return failure(
      "Product Engineer is not configured on this server. Set CURSOR_API_KEY, LINEAR_API_KEY, and PE_REPOS.",
    );
  }
  const { runner, store } = tools;

  try {
    switch (toolName) {
      case "start_product_engineer_run": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId)
          return failure("ticketId is required, for example ORC-424.");
        if (!connection.actorId) {
          return failure(
            "This run has no signed-in person to attribute it to.",
          );
        }
        const run = await runner.start(ticketId, connection.actorId);
        return asResult(
          `Plan drafted — coding has not started. Approve the plan on /product-engineer (or with approve_product_engineer_plan) before Cursor runs.\n${describe(run)}`,
        );
      }
      case "list_product_engineer_runs": {
        const runs = await store.list();
        if (runs.length === 0) return asResult("No Product Engineer runs yet.");
        return asResult(runs.map(describe).join("\n\n---\n\n"));
      }
      case "get_product_engineer_run": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) return failure("ticketId is required.");
        const run = await store.get(ticketId.trim().toUpperCase());
        if (!run) return failure(`No Product Engineer run for ${ticketId}.`);
        return asResult(describe(run));
      }
      case "sync_product_engineer_run": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) return failure("ticketId is required.");
        const run = await runner.sync(ticketId);
        if (!run) return failure(`No Product Engineer run for ${ticketId}.`);
        return asResult(`Synced from Cursor.\n${describe(run)}`);
      }
      case "approve_product_engineer_plan": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) return failure("ticketId is required.");
        const run = await runner.approvePlan(ticketId);
        return asResult(
          `Plan approved. Cursor cloud coding is starting.\n${describe(run)}`,
        );
      }
      case "reject_product_engineer_plan": {
        const ticketId = stringArg(args, "ticketId");
        const feedback = stringArg(args, "feedback");
        if (!ticketId || !feedback) {
          return failure("ticketId and feedback are both required.");
        }
        const run = await runner.rejectPlan(ticketId, feedback);
        return asResult(
          `Plan revised — still awaiting approval. Coding has not started.\n${describe(run)}`,
        );
      }
      case "resume_product_engineer_run": {
        const ticketId = stringArg(args, "ticketId");
        const feedback = stringArg(args, "feedback");
        if (!ticketId || !feedback) {
          return failure("ticketId and feedback are both required.");
        }
        const run = await runner.resume(ticketId, feedback);
        return asResult(
          `Resume queued. The cloud agent is revising.\n${describe(run)}`,
        );
      }
      case "approve_product_engineer_run": {
        const ticketId = stringArg(args, "ticketId");
        if (!ticketId) return failure("ticketId is required.");
        const run = await runner.approve(ticketId);
        return asResult(
          `Certified in AgentForce. The pull request was not merged.\n${describe(run)}`,
        );
      }
      default:
        return failure(`${toolName} is not a Product Engineer tool.`);
    }
  } catch (error) {
    return failure(messageOf(error));
  }
}
