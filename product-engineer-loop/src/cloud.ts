import { Agent, CursorAgentError } from "@cursor/sdk";
import { buildImplementPrompt, buildResumePrompt } from "./prompts.js";
import type { LinearIssue } from "./linear.js";
import { extractPrUrl, type TicketRun, type RunStatus } from "./types.js";

export type CloudAgentConfig = {
  cursorApiKey: string;
  model: string;
  repos: { url: string; startingRef?: string }[];
};

export type RunOutcome = {
  runId: string;
  status: string;
  result: string | undefined;
};

/** Mid-run updates so AgentForce can show agent id + live assistant text. */
export type ProgressUpdate = {
  agentId?: string;
  lastRunId?: string | null;
  progress?: string;
};

export type OnProgress = (update: ProgressUpdate) => void | Promise<void>;

type CloudAgent = Awaited<ReturnType<typeof Agent.create>>;
type CloudAgentRun = Awaited<ReturnType<CloudAgent["send"]>>;

function tail(text: string, max = 2_500): string {
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

async function streamAndWait(
  run: CloudAgentRun,
  log: (line: string) => void = console.log,
  onProgress?: OnProgress,
): Promise<RunOutcome> {
  log(`run.id=${run.id}`);
  await onProgress?.({ lastRunId: run.id, progress: "Cloud run started…" });

  let assistant = "";
  let lastFlush = 0;
  try {
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            process.stdout.write(block.text);
            assistant += block.text;
            const now = Date.now();
            if (now - lastFlush >= 2_000) {
              lastFlush = now;
              await onProgress?.({
                lastRunId: run.id,
                progress: tail(assistant),
              });
            }
          }
        }
      }
    }
  } catch (error) {
    log(
      `stream ended early: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (assistant.trim()) {
    await onProgress?.({ lastRunId: run.id, progress: tail(assistant) });
  }
  const result = await run.wait();
  process.stdout.write("\n");
  return {
    runId: run.id,
    status: result.status,
    result: typeof result.result === "string" ? result.result : undefined,
  };
}

export function explainBranchAccessError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/Failed to verify existence of branch/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    `${message}\n\n` +
      "If that branch exists in GitHub, Cursor usually cannot see it because the GitHub App " +
      "connected under Dashboard → Integrations does not have access to this private org/repo.\n" +
      "Fix:\n" +
      "  1. Open https://cursor.com/dashboard/integrations → GitHub → Manage\n" +
      "  2. Grant the org and include the private repos listed in PE_REPOS\n" +
      "  3. Retry the Product Engineer run\n" +
      "Optional: set PE_STARTING_REF to an existing branch, or leave it empty for the repo default.",
  );
}

/** Run Cursor cloud Product Engineer to implement a Linear issue. Does not persist. */
export async function runImplement(
  config: CloudAgentConfig,
  issue: LinearIssue,
  log: (line: string) => void = console.log,
  onProgress?: OnProgress,
): Promise<TicketRun> {
  log("Creating cloud agent…");
  let agent: CloudAgent;
  try {
    agent = await Agent.create({
      apiKey: config.cursorApiKey,
      model: { id: config.model },
      cloud: {
        repos: config.repos,
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
  } catch (error) {
    throw explainBranchAccessError(error);
  }
  await using _agent = agent;

  log(`agent.agentId=${agent.agentId}`);
  await onProgress?.({
    agentId: agent.agentId,
    progress: `Cloud agent created (${agent.agentId}). Open Cursor → Agents → SDK to watch it live.`,
  });

  let run: CloudAgentRun;
  try {
    run = await agent.send(buildImplementPrompt(issue));
  } catch (error) {
    throw explainBranchAccessError(error);
  }

  let outcome: RunOutcome;
  try {
    outcome = await streamAndWait(run, log, onProgress);
  } catch (error) {
    if (error instanceof CursorAgentError) {
      throw new Error(
        `Product Engineer failed to start: ${error.message} (retryable=${error.isRetryable})`,
      );
    }
    throw explainBranchAccessError(error);
  }

  const base = {
    ticketId: issue.identifier,
    linearIssueId: issue.id,
    title: issue.title,
    linearUrl: issue.url,
    agentId: agent.agentId,
    lastRunId: outcome.runId,
    repos: config.repos.map((r) => r.url),
    prUrl: extractPrUrl(outcome.result),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: outcome.result ? tail(outcome.result) : null,
  };

  if (outcome.status === "error") {
    return {
      ...base,
      status: "failed" satisfies RunStatus,
      history: [
        {
          at: new Date().toISOString(),
          kind: "start",
          runId: outcome.runId,
          note: "run status error",
        },
      ],
    };
  }

  return {
    ...base,
    status: "awaiting_review",
    history: [
      {
        at: new Date().toISOString(),
        kind: "start",
        runId: outcome.runId,
      },
    ],
  };
}

/** Resume an existing cloud agent with human/QA feedback. Does not persist. */
export async function runResume(
  config: CloudAgentConfig,
  existing: TicketRun,
  feedback: string,
  log: (line: string) => void = console.log,
  onProgress?: OnProgress,
): Promise<TicketRun> {
  await using agent = await Agent.resume(existing.agentId, {
    apiKey: config.cursorApiKey,
    model: { id: config.model },
  });

  log(`resumed agent.agentId=${agent.agentId}`);
  await onProgress?.({
    agentId: agent.agentId,
    progress: "Resumed cloud agent; waiting for revisions…",
  });

  let run: CloudAgentRun;
  try {
    run = await agent.send(buildResumePrompt(feedback, existing.ticketId));
  } catch (error) {
    throw explainBranchAccessError(error);
  }

  let outcome: RunOutcome;
  try {
    outcome = await streamAndWait(run, log, onProgress);
  } catch (error) {
    if (error instanceof CursorAgentError) {
      throw new Error(
        `Resume failed to start: ${error.message} (retryable=${error.isRetryable})`,
      );
    }
    throw explainBranchAccessError(error);
  }

  return {
    ...existing,
    lastRunId: outcome.runId,
    status: outcome.status === "error" ? "failed" : "awaiting_review",
    prUrl: extractPrUrl(outcome.result) ?? existing.prUrl,
    progress: outcome.result ? tail(outcome.result) : existing.progress,
    updatedAt: new Date().toISOString(),
    history: [
      ...existing.history,
      {
        at: new Date().toISOString(),
        kind: "resume",
        runId: outcome.runId,
        note: feedback.slice(0, 500),
      },
    ],
  };
}

/** Pure: mark a run approved. Does not merge. */
export function approveRun(existing: TicketRun): TicketRun {
  return {
    ...existing,
    status: "approved",
    updatedAt: new Date().toISOString(),
    history: [
      ...existing.history,
      {
        at: new Date().toISOString(),
        kind: "approve",
        runId: existing.lastRunId,
        note: "Human certified. Merge stays a human action.",
      },
    ],
  };
}
